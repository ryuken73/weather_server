const fastify = require('fastify')({ logger: true });

// @fastify/compress 등록
(async () => {
    await fastify.register(require('@fastify/compress'),{threshold: 2048, global: true })
    console.log("compress ok");
    fastify.get('/test', async (request, reply) => {
      const largeData = { data: 'x'.repeat(10000) }; // 약 10KB JSON
      reply.header('Content-Type', 'application/json');
      return largeData;
    });
    const start = async () => {
    try {
      await fastify.listen({ port: 3010, host: '0.0.0.0' });
      fastify.log.info('Server running on http://localhost:3010');
    } catch (err) {
      fastify.log.error(err);
      process.exit(1);
    }
    };

    start();
})();
// fastify.register(require('@fastify/compress'), {
//   global: true,
//   threshold: 1024, // 1KB 이상 압축
// }).after((err) => {
//   if (err) {
//     fastify.log.error('Failed to register compression plugin:', err);
//   } else {
//     fastify.log.info('Compression plugin registered successfully');
//   }
// });

// 테스트 엔드포인트
