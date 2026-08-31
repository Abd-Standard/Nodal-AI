/**
 * tests/soroban_event_indexer.test.ts
 * Tests for SorobanEventIndexerTool (#390)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SorobanEventIndexerTool } from '../backend/tools/SorobanEventIndexerTool';
import * as rpcClient from '../backend/rpc_client';

vi.mock('../backend/rpc_client', () => ({
  sorobanServer: {
    getEvents: vi.fn(),
  },
}));

const VALID_CONTRACT = 'CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH';

function makeEvent(id: string, pagingToken: string) {
  return {
    id,
    topic: [{ toString: () => 'released' }],
    pagingToken,
  } as any;
}

describe('SorobanEventIndexerTool', () => {
  let tool: SorobanEventIndexerTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new SorobanEventIndexerTool();
  });

  it('returns historical events and latest ledger', async () => {
    const event = makeEvent('evt-1', 'tok-1');
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [event],
      latestLedger: 500,
    } as any);

    const result = await tool.query({
      contractId: VALID_CONTRACT,
      fromLedger: 100,
      toLedger: 500,
    });

    expect(result.events).toEqual([event]);
    expect(result.latestLedger).toBe(500);
    expect(rpcClient.sorobanServer.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        startLedger: 100,
        endLedger: 500,
        filters: [{ type: 'contract', contractIds: [VALID_CONTRACT] }],
      })
    );
  });

  it('applies topic filter when provided', async () => {
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [],
      latestLedger: 200,
    } as any);

    await tool.query({
      contractId: VALID_CONTRACT,
      fromLedger: 100,
      toLedger: 200,
      topics: [['released']],
    });

    expect(rpcClient.sorobanServer.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          {
            type: 'contract',
            contractIds: [VALID_CONTRACT],
            topics: [['released']],
          },
        ],
      })
    );
  });

  it('rejects invalid ledger range', async () => {
    await expect(
      tool.query({ contractId: VALID_CONTRACT, fromLedger: 500, toLedger: 100 })
    ).rejects.toThrow('fromLedger must be less than or equal to toLedger');
  });
});
