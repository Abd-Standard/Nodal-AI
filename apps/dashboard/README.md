# Nodal AI Dashboard

A visual dashboard for monitoring and controlling Nodal AI agents in real-time.

## Features

- **Live Spending Gauge**: Real-time visualization of spending against the configured limit
- **Task History**: View recent agent tasks with success/failure status
- **Pending Approvals**: Review and approve/deny pending payment approvals
- **Pause/Resume Control**: Halt or resume value-moving tasks with a single click
- **Real-time Updates**: SSE (Server-Sent Events) stream for live data updates
- **Secure Authentication**: API token-based authentication

## Screenshots

![Dashboard Screenshot](./screenshot.png)

## Development

### Prerequisites

- Node.js 22+
- npm

### Local Development

1. **Install dependencies**:
   ```bash
   cd apps/dashboard
   npm install
   ```

2. **Start the development server**:
   ```bash
   npm run dev
   ```

3. **Open your browser**:
   Navigate to `http://localhost:5173`

4. **Connect to your agent**:
   - API URL: `http://localhost:3000` (or your agent's URL)
   - API Token: Your `ADMIN_API_TOKEN` or `WEBHOOK_SECRET`

### Environment Variables

The dashboard uses Vite environment variables for configuration:

- `VITE_API_URL`: Default API URL (default: `http://localhost:3000`)
- `VITE_API_TOKEN`: Default API token (optional, can be entered in UI)

### Building for Production

```bash
npm run build
```

The built files will be in the `dist/` directory.

### Type Checking

```bash
npm run typecheck
```

### Linting

```bash
npm run lint
```

## Docker Deployment

The dashboard can be run via Docker Compose with the `dashboard` profile:

```bash
docker compose --profile dashboard up --build
```

This will:
- Start the agent service (if not already running)
- Start the dashboard on port 5173
- Configure the dashboard to connect to the agent automatically

### Docker Configuration

The dashboard service in `docker-compose.yml`:
- Depends on the `agent` service
- Exposes port 5173
- Uses the `node-builder` Dockerfile stage
- Runs Vite in development mode for hot reloading

## API Endpoints Used

The dashboard consumes the following HTTP API endpoints from the Nodal agent:

- `GET /health` - Health check (optional)
- `GET /status?limit=N` - Task history
- `GET /spending` - Current spending status
- `GET /approvals` - Pending approvals
- `POST /approvals/:id` - Approve/deny a pending approval
- `POST /admin/pause` - Pause the agent
- `POST /admin/resume` - Resume the agent
- `GET /stream` - SSE stream for real-time updates

## Authentication

The dashboard requires API token authentication. The token can be:
1. Provided via the UI on first load
2. Set via the `VITE_API_TOKEN` environment variable
3. Stored in localStorage for persistence

The token is sent via:
- `Authorization: Bearer <token>` header for HTTP requests
- `?token=<token>` query parameter for SSE connections (EventSource doesn't support custom headers)

## Security Considerations

- The dashboard is read-only by default (except for pause/resume and approval actions)
- API tokens are stored in localStorage in the browser
- For production deployment, consider:
  - Using HTTPS
  - Implementing proper session management
  - Adding rate limiting
  - Running behind an authentication proxy

## Troubleshooting

### SSE Connection Issues

If the dashboard shows "Disconnected":
- Verify the agent is running and accessible
- Check that the API token is correct
- Ensure the agent's `/stream` endpoint is accessible from the dashboard
- Check browser console for errors

### CORS Issues

If you encounter CORS errors in development:
- The Vite proxy is configured to proxy `/stream` requests
- Ensure the agent allows requests from the dashboard origin
- For production, configure proper CORS settings on the agent

### Docker Build Issues

If the dashboard fails to build in Docker:
- Ensure `apps/dashboard/package.json` exists
- Check that node_modules are properly installed
- Verify the Dockerfile copies the dashboard source files

## Architecture

The dashboard is a React + TypeScript application built with Vite:

- **React**: UI framework
- **TypeScript**: Type safety
- **Vite**: Build tool and dev server
- **Axios**: HTTP client for API requests
- **EventSource**: Native browser API for SSE

The dashboard maintains real-time connections via SSE and polls for changes in:
- Spending totals
- Approval queue
- Agent pause/resume state

## Contributing

When making changes to the dashboard:
1. Ensure type checking passes: `npm run typecheck`
2. Test the UI locally with a running agent
3. Test Docker deployment: `docker compose --profile dashboard up --build`
4. Update this README if adding new features
