import { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

interface SpendingStatus {
  total: number;
  limit: number;
  percentUsed: number;
  windowMs: number;
}

interface Approval {
  id: string;
  taskType: string;
  amount: string;
  status: string;
  createdAt: number;
  expiresAt: number;
}

interface TaskResult {
  timestamp: string;
  taskType: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

function App() {
  const [apiToken, setApiToken] = useState(() => localStorage.getItem('nodal_api_token') || '');
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem('nodal_api_url') || 'http://localhost:3000');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [spending, setSpending] = useState<SpendingStatus | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [tasks, setTasks] = useState<TaskResult[]>([]);
  const [paused, setPaused] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>(
    isAuthenticated ? 'connecting' : 'disconnected'
  );
  const [error, setError] = useState<string | null>(null);

  // Save settings to localStorage
  useEffect(() => {
    localStorage.setItem('nodal_api_token', apiToken);
    localStorage.setItem('nodal_api_url', apiUrl);
  }, [apiToken, apiUrl]);

  // Fetch initial data
  const fetchInitialData = async () => {
    try {
      const headers = apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
      
      // Fetch spending
      const spendingRes = await axios.get(`${apiUrl}/spending`, { headers });
      setSpending(spendingRes.data);

      // Fetch approvals
      const approvalsRes = await axios.get(`${apiUrl}/approvals`, { headers });
      setApprovals(approvalsRes.data.approvals || []);

      // Fetch task history
      const statusRes = await axios.get(`${apiUrl}/status?limit=20`, { headers });
      setTasks(statusRes.data.results || []);

      // Fetch paused state
      // Paused state is tracked via SSE, so we don't need to fetch it here

      setIsAuthenticated(true);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect to API';
      setError(message);
      setIsAuthenticated(false);
    }
  };

  // SSE connection
  useEffect(() => {
    if (!isAuthenticated) return;

    // Note: EventSource doesn't support custom headers, so we pass token in URL
    // The backend should check for it there as a fallback
    const eventSource = new EventSource(`${apiUrl}/stream?token=${encodeURIComponent(apiToken)}`);

    eventSource.onopen = () => {
      setConnectionStatus('connected');
      setError(null);
    };

    eventSource.onerror = () => {
      setConnectionStatus('disconnected');
      setError('SSE connection lost');
    };

    eventSource.addEventListener('initial', (e) => {
      const data = JSON.parse(e.data);
      setSpending(data.spending);
      setApprovals(data.approvals || []);
      setPaused(data.paused);
    });

    eventSource.addEventListener('spending', (e) => {
      const data = JSON.parse(e.data);
      setSpending(data);
    });

    eventSource.addEventListener('approvals', (e) => {
      const data = JSON.parse(e.data);
      setApprovals(data.approvals || []);
    });

    eventSource.addEventListener('pause', (e) => {
      const data = JSON.parse(e.data);
      setPaused(data.paused);
    });

    eventSource.addEventListener('heartbeat', () => {
      setConnectionStatus('connected');
    });

    return () => {
      eventSource.close();
    };
  }, [isAuthenticated, apiUrl, apiToken]);

  // Manual refresh
  const handleRefresh = () => {
    fetchInitialData();
  };

  // Pause/Resume agent
  const togglePause = async () => {
    try {
      const headers = apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
      const endpoint = paused ? '/admin/resume' : '/admin/pause';
      await axios.post(`${apiUrl}${endpoint}`, {}, { headers });
      // State will update via SSE
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle pause state');
    }
  };

  // Approve/Deny approval
  const handleApproval = async (id: string, decision: 'approve' | 'deny') => {
    try {
      const headers = apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
      await axios.post(`${apiUrl}/approvals/${id}`, { decision }, { headers });
      // Refresh approvals
      const approvalsRes = await axios.get(`${apiUrl}/approvals`, { headers });
      setApprovals(approvalsRes.data.approvals || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process approval');
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="container">
        <div className="auth-form">
          <h1>Nodal AI Dashboard</h1>
          <p>Enter your API credentials to connect</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              fetchInitialData();
            }}
          >
            <div className="form-group">
              <label htmlFor="apiUrl">API URL</label>
              <input
                id="apiUrl"
                type="text"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="http://localhost:3000"
              />
            </div>
            <div className="form-group">
              <label htmlFor="apiToken">API Token</label>
              <input
                id="apiToken"
                type="password"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="Enter your ADMIN_API_TOKEN"
              />
            </div>
            {error && <div className="error">{error}</div>}
            <button type="submit" className="btn btn-primary">
              Connect
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <header className="header">
        <h1>Nodal AI Dashboard</h1>
        <div className="header-controls">
          <div className={`connection-status ${connectionStatus}`}>
            {connectionStatus === 'connected' && '● Connected'}
            {connectionStatus === 'connecting' && '○ Connecting...'}
            {connectionStatus === 'disconnected' && '● Disconnected'}
          </div>
          <button onClick={handleRefresh} className="btn btn-secondary">
            Refresh
          </button>
          <button
            onClick={() => {
              setIsAuthenticated(false);
              setConnectionStatus('disconnected');
            }}
            className="btn btn-secondary"
          >
            Disconnect
          </button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="dashboard-grid">
        {/* Spending Gauge */}
        <div className="card">
          <h2>Spending</h2>
          {spending && (
            <div className="spending-gauge">
              <div className="gauge-container">
                <div
                  className="gauge-fill"
                  style={{
                    width: `${Math.min(spending.percentUsed, 100)}%`,
                    backgroundColor: spending.percentUsed > 80 ? '#ef4444' : spending.percentUsed > 50 ? '#f59e0b' : '#10b981',
                  }}
                />
              </div>
              <div className="gauge-value">
                <span className="gauge-current">{spending.total.toFixed(2)}</span>
                <span className="gauge-separator">/</span>
                <span className="gauge-limit">{spending.limit}</span>
              </div>
              <div className="gauge-percent">{spending.percentUsed.toFixed(1)}%</div>
            </div>
          )}
        </div>

        {/* Pause Button */}
        <div className="card">
          <h2>Agent Control</h2>
          <div className="pause-control">
            <div className={`pause-status ${paused ? 'paused' : 'running'}`}>
              {paused ? '⏸ Paused' : '▶ Running'}
            </div>
            <button
              onClick={togglePause}
              className={`btn ${paused ? 'btn-success' : 'btn-danger'}`}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
          </div>
        </div>

        {/* Pending Approvals */}
        <div className="card card-full">
          <h2>Pending Approvals ({approvals.length})</h2>
          {approvals.length === 0 ? (
            <p className="empty-state">No pending approvals</p>
          ) : (
            <div className="approvals-list">
              {approvals.map((approval) => (
                <div key={approval.id} className="approval-item">
                  <div className="approval-info">
                    <div className="approval-type">{approval.taskType}</div>
                    <div className="approval-amount">{approval.amount}</div>
                    <div className="approval-time">
                      {new Date(approval.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="approval-actions">
                    <button
                      onClick={() => handleApproval(approval.id, 'approve')}
                      className="btn btn-success btn-sm"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleApproval(approval.id, 'deny')}
                      className="btn btn-danger btn-sm"
                    >
                      Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Task History */}
        <div className="card card-full">
          <h2>Task History</h2>
          {tasks.length === 0 ? (
            <p className="empty-state">No task history</p>
          ) : (
            <div className="tasks-list">
              {tasks.map((task, index) => (
                <div key={index} className={`task-item ${task.success ? 'success' : 'failure'}`}>
                  <div className="task-info">
                    <div className="task-type">{task.taskType}</div>
                    <div className="task-time">{new Date(task.timestamp).toLocaleString()}</div>
                  </div>
                  <div className={`task-status ${task.success ? 'success' : 'failure'}`}>
                    {task.success ? '✓ Success' : '✗ Failed'}
                  </div>
                  {task.error && <div className="task-error">{task.error}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
