// Entry point the MCP server and CLI spawn (detached) when no daemon is running.
import { startDaemon } from './daemon.js'

startDaemon().catch((err) => {
  console.error(err)
  process.exit(1)
})
