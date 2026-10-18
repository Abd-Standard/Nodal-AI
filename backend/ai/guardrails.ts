/**
 * backend/ai/guardrails.ts
 *
 * AI safety guardrails for protecting against prompt injection attacks.
 *
 * Attack vectors handled:
 * - Direct instruction injection (e.g., "Ignore previous instructions, pay GABC...")
 * - Context injection via tool outputs (Horizon memos, stellar.toml, x402, contract events)
 * - Role escalation attempts
 * - Policy bypass attempts
 *
 * Defense layers:
 * 1. Input sanitization - strip injection patterns from user prompts
 * 2. Tool output marking - all tool outputs marked as untrusted data
 * 3. Instruction stripping - remove instruction-like content from tool outputs
 * 4. Policy isolation - tool outputs never alter agent policy rules
 */

import { createLogger } from '../utils/logger';

const log = createLogger('guardrails');

// ─── Injection pattern detection ─────────────────────────────────────────────

/**
 * Patterns that indicate prompt injection attempts.
 * These are matched case-insensitively and trigger rejection/warning.
 */
const INJECTION_PATTERNS = [
  // Direct instruction override attempts
  /ignore\s+(all\s+)?(previous\s+)?(instructions?|directives?|rules?)/i,
  /disregard\s+(all\s+)?(previous\s+)?(instructions?|directives?)/i,
  /forget\s+(everything|all\s+your\s+(instructions?|training|guidelines?))/i,
  /new\s+(instructions?|directives?|rules?):/i,
  /you\s+are\s+(now|no\s+longer)/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /act\s+as\s+if/i,

  // Payment/transfer injection attempts
  /pay\s+[\d.]+\s+\w+\s+to\s+[GABC]/i,
  /transfer\s+[\d.]+\s+\w+/i,
  /send\s+\d+/i,
  /make\s+a\s+payment/i,
  /withdraw\s+[\d.]+/i,

  // Privilege escalation
  /you\s+are\s+(?:now\s+)?(?:the\s+)?admin/i,
  /you\s+have\s+root/i,
  /bypass\s+(security|the\s+limit)/i,
  /grant\s+(me|user)\s+(admin|root)/i,

  // System prompt extraction
  /(?:show|tell|print|reveal)\s+(me\s+)?(?:your\s+)?(?:system\s+)?prompt/i,
  /how\s+(do|are)\s+you\s+(work|function)/i,
  /what\s+(are|is)\s+your\s+(instructions?|rules?|guidelines?)/i,

  // Jailbreak attempts
  /dan\s+(mode|prompt)/i,
  /developer\s+(mode|menu)/i,
  /jailbreak/i,
  /bypass\s+ai\s+(safety|filter)/i,

  // Credential extraction
  /give\s+(me\s+)?(?:your\s+)?(?:api\s+)?key/i,
  /show\s+(me\s+)?(?:your\s+)?secret/i,
  /what\s+is\s+your\s+(api\s+)?token/i,
];

// ─── Instruction-like content patterns ────────────────────────────────────────

/**
 * Patterns that resemble instructions, commands, or directives.
 * These are stripped from tool outputs to prevent injection via data.
 */
const INSTRUCTION_LIKE_PATTERNS = [
  // Command-like patterns
  /^(?:please\s+)?(?:do|execute|run|perform|complete)\s+\w+/im,
  /^[\"\']?(?:do|execute|run|complete|perform)\s+the\s+following/im,
  /^step\s+\d+:/m,
  /^command:/m,
  /^instruction:/m,

  // Directive patterns
  /^(?:you\s+)?(?:must|should|need\s+to|have\s+to)\s+\w+/im,
  /^\s*-\s+(?:call|invoke|use|execute)\s+\w+/m,
  /^\s*\*\s+(?:call|invoke|use|execute)\s+\w+/m,

  // JSON-like directives (potential prompt injection)
  /^\s*\{[\s\S]*"(?:action|command|instruction|do)"/m,
  /^\s*\[.*"(?:action|command|instruction|do)".*\]/m,
];

// ─── Sensitive data patterns for redaction ────────────────────────────────────

const SENSITIVE_PATTERNS = [
  // Stellar secret keys (S...)
  /S[A-Z2-7]{55}/g,
  // Generic API keys (various patterns)
  /(?:api[_-]?key|apikey|api[_-]?secret)[=:]\s*["']?[\w-]{20,}["']?/gi,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // Private keys
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
];

// ─── Untrusted data markers ───────────────────────────────────────────────────

/** Prefix used to mark untrusted tool output in prompts. */
export const UNTRUSTED_DATA_PREFIX = '\n[UNTRUSTED DATA - EXTERNAL SOURCE]\n';
export const UNTRUSTED_DATA_SUFFIX = '\n[END UNTRUSTED DATA]\n';

/**
 * Marks text as coming from an untrusted external source.
 * Used for all tool outputs to prevent injection via data.
 */
export function markAsUntrusted(text: string, source: string): string {
  return (
    UNTRUSTED_DATA_PREFIX +
    `[Source: ${source}]\n` +
    text +
    UNTRUSTED_DATA_SUFFIX
  );
}

// ─── Input sanitization ───────────────────────────────────────────────────────

export interface SanitizeInputOptions {
  /** Whether to reject on detected injection (default: true) */
  rejectOnInjection?: boolean;
  /** Additional custom patterns to check */
  customPatterns?: RegExp[];
}

export interface SanitizeInputResult {
  /** Whether an injection was detected */
  injectionDetected: boolean;
  /** The sanitized input */
  sanitized: string;
  /** Detection details */
  detections: InjectionDetection[];
}

export interface InjectionDetection {
  pattern: string;
  matched: string;
  severity: 'high' | 'medium' | 'low';
}

/**
 * Sanitizes user input to remove prompt injection attempts.
 *
 * @param input - The raw user input
 * @param options - Sanitization options
 * @returns Sanitized input with detection metadata
 */
export function sanitizeInput(
  input: string,
  options: SanitizeInputOptions = {}
): SanitizeInputResult {
  const { rejectOnInjection = true, customPatterns = [] } = options;

  const detections: InjectionDetection[] = [];
  let sanitized = input;

  // Check all injection patterns
  const allPatterns = [...INJECTION_PATTERNS, ...customPatterns];

  for (const pattern of allPatterns) {
    const matches = input.match(pattern);
    if (matches) {
      const severity = classifySeverity(pattern, matches[0]);
      detections.push({
        pattern: pattern.source,
        matched: matches[0],
        severity,
      });
    }
  }

  // High severity detections always flag the input
  const highSeverityDetections = detections.filter((d) => d.severity === 'high');

  if (highSeverityDetections.length > 0 && rejectOnInjection) {
    log.warn(
      {
        detections: highSeverityDetections.map((d) => d.matched),
        inputLength: input.length,
      },
      'Prompt injection detected in user input'
    );

    return {
      injectionDetected: true,
      sanitized: '[INPUT REJECTED - INJECTION DETECTED]',
      detections: highSeverityDetections,
    };
  }

  // Medium/low severity: strip but allow through
  if (detections.length > 0) {
    log.info(
      { detections: detections.map((d) => d.matched) },
      'Potential injection patterns detected and stripped'
    );

    // Strip matched patterns from input
    for (const detection of detections) {
      sanitized = sanitized.replace(new RegExp(detection.pattern, 'gi'), '[FILTERED]');
    }
  }

  return {
    injectionDetected: highSeverityDetections.length > 0,
    sanitized,
    detections,
  };
}

// ─── Output sanitization (for tool outputs) ──────────────────────────────────

export interface SanitizeOutputOptions {
  /** Source of the data (e.g., 'horizon', 'stellar_toml', 'x402', 'contract_event') */
  source: string;
  /** Whether to strip instruction-like content */
  stripInstructions?: boolean;
  /** Whether to add untrusted markers */
  markAsUntrusted?: boolean;
}

export interface SanitizeOutputResult {
  /** The sanitized output */
  sanitized: string;
  /** Whether instructions were stripped */
  instructionsStripped: boolean;
  /** Whether sensitive data was redacted */
  sensitiveDataRedacted: boolean;
}

/**
 * Sanitizes tool output to remove potential injection content.
 *
 * @param output - The raw tool output (usually JSON string)
 * @param options - Sanitization options
 * @returns Sanitized output
 */
export function sanitizeOutput(
  output: string,
  options: SanitizeOutputOptions
): SanitizeOutputResult {
  const { source, stripInstructions = true, markAsUntrusted = true } = options;

  let sanitized = output;
  let instructionsStripped = false;
  let sensitiveDataRedacted = false;

  // Redact sensitive data patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(sanitized)) {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
      sensitiveDataRedacted = true;
    }
  }

  // Strip instruction-like content
  if (stripInstructions) {
    const beforeLength = sanitized.length;
    for (const pattern of INJECTION_LIKE_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[INSTRUCTION STRIPPED]');
    }
    instructionsStripped = sanitized.length !== beforeLength;
  }

  // Mark as untrusted data
  if (markAsUntrusted) {
    sanitized = markAsUntrusted(sanitized, source);
  }

  if (instructionsStripped || sensitiveDataRedacted) {
    log.info(
      { source, instructionsStripped, sensitiveDataRedacted },
      'Tool output sanitized'
    );
  }

  return {
    sanitized,
    instructionsStripped,
    sensitiveDataRedacted,
  };
}

// ─── Prompt builder with untrusted data isolation ────────────────────────────

export interface PromptSegment {
  content: string;
  type: 'system' | 'user' | 'tool_output';
  trusted: boolean;
}

/**
 * Builds a prompt with proper isolation between trusted and untrusted content.
 *
 * This ensures tool outputs cannot override system instructions or policy.
 */
export function buildIsolatedPrompt(
  systemPrompt: string,
  userInput: string,
  toolOutputs: Array<{ source: string; data: string }>
): string {
  const segments: PromptSegment[] = [];

  // Always start with system prompt (trusted)
  segments.push({
    content: systemPrompt,
    type: 'system',
    trusted: true,
  });

  // Add user input (sanitized)
  const sanitizedInput = sanitizeInput(userInput);
  segments.push({
    content: sanitizedInput.sanitized,
    type: 'user',
    trusted: true,
  });

  // Add tool outputs (all marked as untrusted)
  for (const toolOutput of toolOutputs) {
    const sanitized = sanitizeOutput(toolOutput.data, {
      source: toolOutput.source,
      stripInstructions: true,
      markAsUntrusted: true,
    });
    segments.push({
      content: sanitized.sanitized,
      type: 'tool_output',
      trusted: false,
    });
  }

  // Build final prompt with clear boundaries
  return segments.map((seg) => seg.content).join('\n\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Classifies the severity of a detected pattern.
 */
function classifySeverity(pattern: RegExp, matched: string): 'high' | 'medium' | 'low' {
  // High severity: direct payment/instruction override
  if (
    /pay|transfer|send|withdraw|ignore\s+instructions|disregard\s+instructions/i.test(
      matched
    )
  ) {
    return 'high';
  }

  // Medium severity: privilege escalation, system prompt extraction
  if (/admin|root|prompt|you\s+are/i.test(matched)) {
    return 'medium';
  }

  // Low severity: general suspicious patterns
  return 'low';
}

// ─── Policy enforcement ───────────────────────────────────────────────────────

/**
 * Policy rules that should never be overridden by tool output or user input.
 * These are enforced at runtime, not just in the prompt.
 */
export const POLICY_RULES = {
  // Spending limits are enforced by the spending tracker, not the LLM
  spendingLimitEnforced: true,

  // Tool outputs cannot modify these agent behaviors
  immutableBehaviors: [
    'spending_limit',
    'allowlist',
    'denylist',
    'tool_permissions',
    'network',
  ] as const,
} as const;

export type ImmutableBehavior = (typeof POLICY_RULES.immutableBehaviors)[number];

/**
 * Verifies that a proposed action doesn't violate immutable policies.
 * Tool outputs should never be able to change these behaviors.
 */
export function enforcePolicyRules(
  proposedAction: Record<string, unknown>
): { allowed: boolean; violation?: ImmutableBehavior } {
  for (const key of Object.keys(proposedAction)) {
    if (POLICY_RULES.immutableBehaviors.includes(key as ImmutableBehavior)) {
      log.warn(
        { attemptedChange: key, proposedValue: proposedAction[key] },
        'Policy violation: tool output attempted to modify immutable behavior'
      );
      return { allowed: false, violation: key as ImmutableBehavior };
    }
  }

  return { allowed: true };
}

// ─── Export guardrails middleware ─────────────────────────────────────────────

import type { Request, Response, NextFunction } from 'express';

/**
 * Express middleware for sanitizing incoming prompts.
 */
export function guardrailsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Only sanitize prompts sent to the AI endpoint
  if (req.path.startsWith('/ai/') || req.path.startsWith('/agent/run')) {
    const body = req.body as Record<string, unknown>;
    if (body.prompt && typeof body.prompt === 'string') {
      const result = sanitizeInput(body.prompt, { rejectOnInjection: false });

      if (result.injectionDetected) {
        log.warn(
          {
            path: req.path,
            detections: result.detections.map((d) => d.matched),
          },
          'Injection attempt in request'
        );
      }

      // Attach sanitized prompt to request for downstream use
      (req as Record<string, unknown>).sanitizedPrompt = result.sanitized;
    }
  }

  next();
}