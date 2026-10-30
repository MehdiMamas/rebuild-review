import net from 'node:net';

const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  server.close(() => console.log(port));
});
