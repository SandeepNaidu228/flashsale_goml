
const dotenv = require("dotenv");
const { Pool } = require("pg");
const amqp = require("amqplib");

dotenv.config();

const pool = new Pool({
  host: "127.0.0.1",
  port: 5433,
  user: "flashsale",
  password: process.env.DB_PASSWORD,
  database: "flashsale",
});

async function startWorker() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  const channel = await connection.createConfirmChannel();

  await channel.assertExchange("checkout_dlx", "direct", {
    durable: true,
  });

  await channel.assertQueue("checkout_dead", {
    durable: true,
  });

  await channel.bindQueue(
    "checkout_dead",
    "checkout_dlx",
    "checkout_failed"
  );

  await channel.assertQueue("checkout_queue", {
    durable: true,
  });

  channel.prefetch(10);

  console.log("Checkout worker ready");

  channel.consume("checkout_queue", async (message) => {
    if (!message) return;

    let client;
    let transactionStarted = false;

    try {
      const job = JSON.parse(message.content.toString());

      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      const order = await client.query(
        "SELECT status FROM orders WHERE id = $1 FOR UPDATE",
        [job.orderId]
      );

      if (!order.rowCount) {
        throw new Error("Order does not exist yet");
      }

      // Duplicate delivery: don't deduct inventory again.
      if (order.rows[0].status !== "PENDING") {
        await client.query("COMMIT");
        transactionStarted = false;
        channel.ack(message);
        return;
      }

      const inventory = await client.query(
        `UPDATE inventory
         SET stock = stock - $1
         WHERE product_id = $2 AND stock >= $1
         RETURNING stock`,
        [job.quantity, job.productId]
      );

      if (!inventory.rowCount) {
        await client.query(
          "UPDATE orders SET status = 'FAILED' WHERE id = $1",
          [job.orderId]
        );
      } else {
        await client.query(
          "UPDATE orders SET status = 'CONFIRMED' WHERE id = $1",
          [job.orderId]
        );
      }

      await client.query("COMMIT");
      transactionStarted = false;

      channel.ack(message);

      console.log(
        `Order ${job.orderId}:`,
        inventory.rowCount ? "CONFIRMED" : "FAILED"
      );
    } catch (err) {
      if (client && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Rollback error:", rollbackError.message);
        }
      }

      console.error("Worker error:", err.message);

      try {
        const headers = message.properties.headers || {};
        const retries = Number(headers["x-retry-count"] || 0);

        if (retries < 3) {
          channel.sendToQueue(
            "checkout_queue",
            message.content,
            {
              persistent: true,
              headers: {
                ...headers,
                "x-retry-count": retries + 1,
              },
            }
          );

          await channel.waitForConfirms();
          channel.ack(message);
        } else {
          // Dead-letter the original message after three retries.
          channel.nack(message, false, false);
        }
      } catch (publishError) {
        console.error("Retry publish failed:", publishError.message);

        // Don't acknowledge the original if republishing failed.
        // Requeue it for a later attempt.
        channel.nack(message, false, true);
      }
    } finally {
      if (client) client.release();
    }
  });
}

startWorker().catch((err) => {
  console.error("Worker startup failed:", err);
  process.exit(1);
});
