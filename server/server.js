
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const crypto = require("crypto");
const { Pool } = require("pg");
const { createClient } = require("redis");
const amqp = require("amqplib");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("X-API-Instance", process.env.INSTANCE_ID || "local");
  next();
});

const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5433),
  user: "flashsale",
  password: process.env.DB_PASSWORD,
  database: "flashsale",
});

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (err) => console.error("Redis:", err.message));

let rabbitConnection;
let rabbitChannel;

const QUEUE = "checkout_queue";
const STOCK_KEY = "flashsale:stock";

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

async function connectServices() {
  await pool.query("SELECT 1");
  console.log("PostgreSQL connected");

  await redis.connect();
  console.log("Redis connected");

  const inventory = await pool.query(
    "SELECT stock FROM inventory WHERE product_id = 1"
  );

  if (inventory.rowCount === 0) {
    throw new Error("Flash-sale inventory is missing");
  }

  // Initialize only if Redis has no stock counter yet.
  await redis.set(
    STOCK_KEY,
    String(inventory.rows[0].stock),
    { NX: true }
  );

  rabbitConnection = await amqp.connect(
    process.env.RABBITMQ_URL
  );

  rabbitChannel = await rabbitConnection.createConfirmChannel();
  await rabbitChannel.assertQueue(QUEUE, { durable: true });

  console.log("RabbitMQ connected");
}


let recoveryRunning = false;

async function recoverStalePendingOrders() {
  if (!rabbitChannel || recoveryRunning) return;

  recoveryRunning = true;

  try {
    const pending = await pool.query(`
      SELECT id, product_id, quantity
      FROM orders
      WHERE status = 'PENDING'
        AND created_at < NOW() - INTERVAL '30 seconds'
      ORDER BY created_at ASC
      LIMIT 100
    `);

    if (pending.rowCount === 0) return;

    for (const order of pending.rows) {
      rabbitChannel.sendToQueue(
        QUEUE,
        Buffer.from(JSON.stringify({
          orderId: order.id,
          productId: order.product_id,
          quantity: order.quantity,
        })),
        { persistent: true }
      );
    }

    await rabbitChannel.waitForConfirms();

    console.log(
      `Recovery: re-published ${pending.rowCount} stale pending order(s)`
    );
  } catch (err) {
    console.error("Pending-order recovery failed:", err.message);
  } finally {
    recoveryRunning = false;
  }
}


app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    await redis.ping();

    res.json({
      status: "ok",
      postgres: "connected",
      redis: "connected",
      rabbitmq: "connected",
    });
  } catch (err) {
    res.status(503).json({ error: "A dependency is unavailable" });
  }
});

app.get("/api/product", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT product_id, product_name, price, stock
       FROM inventory WHERE product_id = 1`
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Product not found" });
    }

    const redisStock = await redis.get(STOCK_KEY);

    res.json({
      ...result.rows[0],
      availableForReservation: Number(redisStock),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch product" });
  }
});

app.post("/api/checkout", async (req, res) => {
  const key = req.get("Idempotency-Key");

  if (!key || key.length > 150) {
    return res.status(400).json({
      error: "Provide an Idempotency-Key header (max 150 characters)",
    });
  }

  const idemKey = "flashsale:idem:" +
    crypto.createHash("sha256").update(key).digest("hex");

  const orderId = crypto.randomUUID();

  try {
    // Fast path: this request may already have an order.
    const existing = await pool.query(
      "SELECT id, status FROM orders WHERE idempotency_key = $1",
      [key]
    );

    if (existing.rowCount) {
      return res.status(200).json(existing.rows[0]);
    }

    const reservation = await redis.eval(reserveScript, {
      keys: [STOCK_KEY, idemKey],
      arguments: [orderId],
    });

    const code = Number(reservation[0]);
    const reservedOrderId = String(reservation[1] || "");

    if (code === 0) {
      return res.status(409).json({
        error: "Sold out",
        availableForReservation: 0,
      });
    }

    // A repeated key reuses the same reservation/order ID.
    const insert = await pool.query(
      `INSERT INTO orders
        (id, idempotency_key, product_id, quantity, status)
       VALUES ($1, $2, 1, 1, 'PENDING')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, status`,
      [reservedOrderId, key]
    );

    if (!insert.rowCount) {
      const duplicate = await pool.query(
        "SELECT id, status FROM orders WHERE idempotency_key = $1",
        [key]
      );

      if (duplicate.rowCount) {
        return res.status(200).json(duplicate.rows[0]);
      }

      throw new Error("Could not create or recover order");
    }

    try {
      rabbitChannel.sendToQueue(
        QUEUE,
        Buffer.from(JSON.stringify({
          orderId: reservedOrderId,
          productId: 1,
          quantity: 1,
        })),
        { persistent: true }
      );

      await rabbitChannel.waitForConfirms();
    } catch (err) {
      console.error("Queue publish failed:", err.message);

      // Keep the reservation and pending order for recovery.
      // Never release stock while an uncertain message may be queued.
      return res.status(503).json({
        orderId: reservedOrderId,
        status: "PENDING",
        message: "Checkout accepted but processing needs recovery",
      });
    }

    return res.status(202).json({
      orderId: reservedOrderId,
      status: "PENDING",
      message: "Checkout accepted for processing",
    });
  } catch (err) {
    console.error("Checkout failed:", err);
    return res.status(500).json({ error: "Checkout could not be processed" });
  }
});

app.get("/api/orders/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, product_id, quantity, status, created_at
       FROM orders WHERE id = $1`,
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Could not fetch order" });
  }
});

async function start() {
  try {
    await connectServices();

    const port = process.env.PORT || 5000;
    app.listen(port, () => {
      console.log(`FlashSale API running on port ${port}`);
    });
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
}

start();
setInterval(() => {
  void recoverStalePendingOrders();
}, 15000).unref();
