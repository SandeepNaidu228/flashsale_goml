
CREATE TABLE IF NOT EXISTS inventory (
    product_id INTEGER PRIMARY KEY,
    product_name VARCHAR(150) NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    stock INTEGER NOT NULL CHECK (stock >= 0),
    initial_stock INTEGER NOT NULL CHECK (initial_stock >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY,
    idempotency_key VARCHAR(150) UNIQUE NOT NULL,
    product_id INTEGER NOT NULL REFERENCES inventory(product_id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO inventory (
    product_id, product_name, price, stock, initial_stock
)
VALUES (1, 'FlashSale Smartphone', 29999.00, 500, 500)
ON CONFLICT (product_id) DO NOTHING;
