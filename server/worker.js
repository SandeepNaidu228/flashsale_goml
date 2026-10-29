
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
  const channel = await connection.createChannel();

  await channel.assertQueue("checkout_queue", { durable: true });
  channel.prefetch(10);

  console.log("Checkout worker ready");

  channel.consume("checkout_queue", async (message) => {
    if (!message) return;

    let job;
    let transactionStarted = false;

    try {
      job = JSON.parse(message.content.toString());

      await pool.query("BEGIN");
      transactionStarted = true;

      const order = await pool.query(
        "SELECT status FROM orders WHERE id = $1 FOR UPDATE",
        [job.orderId]
      );

      if (!order.rowCount) {
        throw new Error("Order does not exist yet");
      }

      // Already processed: acknowledge the duplicate safely.
      if (order.rows[0].status !== "PENDING") {
        await pool.query("COMMIT");
        transactionStarted = false;
        channel.ack(message);
        return;
      }

      const inventory = await pool.query(
        `UPDATE inventory
         SET stock = stock - $1
         WHERE product_id = $2 AND stock >= $1
         RETURNING stock`,
        [job.quantity, job.productId]
      );

      if (!inventory.rowCount) {
        await pool.query(
          "UPDATE orders SET status = 'FAILED' WHERE id = $1",
          [job.orderId]
        );
      } else {
        await pool.query(
          "UPDATE orders SET status = 'CONFIRMED' WHERE id = $1",
          [job.orderId]
        );
      }

      await pool.query("COMMIT");
      transactionStarted = false;

      channel.ack(message);
      console.log(
        `Order ${job.orderId}:`,
        inventory.rowCount ? "CONFIRMED" : "FAILED"
      );
    } catch (err) {
      if (transactionStarted) {
        try {
          await pool.query("ROLLBACK");
        } catch (_) {}
      }

      console.error("Worker error:", err.message);

      // Requeue transient errors; production needs bounded retries
      // and dead-letter handling for permanently invalid messages.
      channel.nack(message, false, true);
    }
  });
}

startWorker().catch((err) => {
  console.error("Worker startup failed:", err);
  process.exit(1);
});
