
const { createClient } = require("redis");
const crypto = require("crypto");

const STOCK_KEY = "flashsale:test:stock";

const reserveScript = `
  local existing = redis.call('GET', KEYS[2])
  if existing then
    return {2, existing}
  end

  local stock = tonumber(redis.call('GET', KEYS[1]) or '-1')
  if stock <= 0 then
    return {0, ''}
  end

  redis.call('DECR', KEYS[1])
  redis.call('SET', KEYS[2], ARGV[1])
  return {1, ARGV[1]}
`;

async function main() {
  const redis = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
  });

  redis.on("error", (err) => console.error("Redis:", err.message));

  await redis.connect();

  try {
    const initialStock = await redis.get(STOCK_KEY);

    if (initialStock !== "5") {
      throw new Error(
        `Expected test stock to be 5, but found ${initialStock}. Reset the isolated test key before running.`
      );
    }

    const results = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const key = `flashsale:test:idem:${crypto.randomUUID()}`;
        const orderId = crypto.randomUUID();

        const result = await redis.eval(reserveScript, {
          keys: [STOCK_KEY, key],
          arguments: [orderId],
        });

        return {
          result: Number(result[0]),
          orderId: String(result[1] || ""),
        };
      })
    );

    const accepted = results.filter((r) => r.result === 1).length;
    const rejected = results.filter((r) => r.result === 0).length;
    const remaining = await redis.get(STOCK_KEY);

    console.log("Reservation attempts:", results.length);
    console.log("Accepted:", accepted);
    console.log("Sold-out rejections:", rejected);
    console.log("Final test stock:", remaining);

    if (
      accepted !== 5 ||
      rejected !== 5 ||
      remaining !== "0"
    ) {
      throw new Error("TEST FAILED: reservation counts are incorrect.");
    }

    console.log("TEST PASSED: no overselling in the isolated Redis counter.");
  } finally {
    await redis.quit();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
