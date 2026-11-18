import { createConnection } from 'node:net';

// Liveness only. The probe never sends HTTP identity, Git RPCs or credentials.
const socket = createConnection(process.argv[2]);
socket.setTimeout(1000, () => socket.destroy(new Error('Socket probe timed out.')));
socket.once('connect', () => socket.destroy());
socket.once('error', () => { process.exitCode = 1; });
