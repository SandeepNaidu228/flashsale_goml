const baseUrl = "http://localhost:5000";
const total = 20;

async function main() {
  const start = performance.now();

  const results = await Promise.all(
    Array.from({ length: total }, async (_, i) => {
      const key = `benchmark-${Date.now()}-${i}-${crypto.randomUUID()}`;

      try {
        const response = await fetch(`${baseUrl}/api/checkout`, {
          method: "POST",
          headers: { "Idempotency-Key": key }
        });

        const body = await response.json();
        return {
          httpStatus: response.status,
          orderId: body.orderId,
          status: body.status
        };
      } catch (error) {
        return { error: error.message };
      }
    })
  );

  const elapsedSeconds = (performance.now() - start) / 1000;
  const accepted = results.filter(r => r.httpStatus === 202).length;

  console.log(JSON.stringify({
    totalRequests: total,
    accepted,
    failed: total - accepted,
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    acceptedRequestsPerSecond: Number((accepted / elapsedSeconds).toFixed(2)),
    results
  }, null, 2));
}

main().catch(console.error);
