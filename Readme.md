
# FlashSale

FlashSale is a checkout-oriented backend designed to handle purchase requests, coordinate inventory, and process orders asynchronously. The current local setup demonstrates two Node.js/Express API instances behind Nginx, sharing PostgreSQL, Redis, and RabbitMQ services.

## Architecture

```text
                         Client
                           |
                           v
                    Nginx :8080
                    /           \
                   v             v
              API instance 1  API instance 2
                 api1:5000       api2:5000
                   |  \           /  |
                   |   \         /   |
                   v    v       v    v
               PostgreSQL    Redis   RabbitMQ
                                      |
                                      v
                                Worker process
```

- **Nginx:** Provides a single entry point and distributes requests between `api1` and `api2` using `least_conn`.
- **API instances:** Validate requests and coordinate checkout operations.
- **Redis:** Supports fast inventory/reservation operations and short-lived state.
- **PostgreSQL:** Stores durable order and inventory records.
- **RabbitMQ:** Queues checkout work for asynchronous processing.
- **Worker:** Processes queued orders and updates persistent order state.

Both API instances connect to the same backing services, so shared order and inventory state is not maintained as separate copies inside each API container.

## Features

- REST API built with Node.js and Express.
- PostgreSQL for durable business data.
- Redis for fast inventory/reservation operations.
- RabbitMQ and a background worker for asynchronous checkout processing.
- Two API containers managed by Docker Compose.
- Nginx reverse proxy and load balancing.
- `X-API-Instance` response header to identify the API instance handling a request.
- `X-API-Upstream` response header to inspect the upstream selected by Nginx.
- Health endpoint for basic service verification.

## Technology Stack

- Node.js and Express
- PostgreSQL
- Redis
- RabbitMQ
- Nginx
- Docker and Docker Compose
- React / Vite frontend

## Prerequisites

- Docker Desktop with Docker Compose
- Node.js and npm for local development or running the frontend outside Docker

## Run with Docker Compose

Run these commands from the project root.

### 1. Validate the Compose configuration

```powershell
docker compose config --quiet
```

### 2. Build the API images

```powershell
docker compose build api1 api2
```

### 3. Start the stack

```powershell
docker compose up -d
```

### 4. Check service status

```powershell
docker compose ps
```

Confirm PostgreSQL, Redis, and RabbitMQ are healthy and that `api1`, `api2`, and `nginx` are running.

### 5. Inspect logs if needed

```powershell
docker compose logs --tail 100 api1 api2 nginx
docker compose logs --tail 100 postgres redis rabbitmq
```

## Service Addresses

| Component | Address |
|---|---|
| Load-balanced API | `http://localhost:8080` |
| PostgreSQL | `localhost:5433` |
| Redis | `localhost:6379` |
| RabbitMQ AMQP | `localhost:5672` |
| RabbitMQ management UI | `http://localhost:15672` |

The `api1` and `api2` hostnames are available on the Docker network. From the host machine, use Nginx at port `8080` to access the API.

## Verify Load Balancing

Send ten requests to the health endpoint through Nginx:

```powershell
1..10 | ForEach-Object {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8080/health"
    [PSCustomObject]@{
        Request  = $_
        Instance = $r.Headers["X-API-Instance"]
        Upstream = $r.Headers["X-API-Upstream"]
        Status   = $r.StatusCode
    }
} | Format-Table -AutoSize
```

Successful responses should return HTTP `200`. The `X-API-Instance` header identifies the API container that handled the request, while `X-API-Upstream` shows the upstream address selected by Nginx.

In our local verification, ten health requests reached both `api1` and `api2`.

This confirms request routing across both API instances. It does not, by itself, prove checkout correctness, high availability, or production-scale throughput.

## Scaling Approach

### API Horizontal Scaling

The project runs two API containers behind one Nginx instance. Incoming requests are routed to either API replica, and both replicas use the same backing services.

This allows API capacity to be increased without maintaining separate order and inventory state in each API process.

### Data-Layer Scaling

The data responsibilities are separated by workload:

- **Redis:** Fast inventory/reservation operations and short-lived state.
- **PostgreSQL:** Durable order and inventory records.
- **RabbitMQ:** Asynchronous checkout work, decoupled from the immediate HTTP request.

Because `api1` and `api2` share these services, adding an API replica does not require a separate database or queue for that replica.

Each service can be monitored and scaled according to its own bottleneck.

**Current scope:** Shared data-service connectivity and two API replicas have been demonstrated locally. PostgreSQL sharding/read replicas, Redis Cluster, multi-node data partitioning, and a multi-host deployment are not part of the verified current setup.

### Future Scaling Considerations

For a larger multi-store system, inventory keys could include `storeId` to keep stock scoped by store and support partitioning across Redis Cluster slots.

This requires careful key/slot design and hot-key analysis. It is a future direction, not an implemented feature in this local setup.

## Design Notes

### 1. Cart Is Not a Reservation

Adding an item to a cart should record purchase intent rather than reserve stock. The authoritative availability check belongs at checkout, reducing the chance that abandoned carts hold inventory.

The backend must enforce the final check; a frontend stock display is not authoritative.

### 2. Atomic Inventory Reservation

For a high-concurrency inventory path, the stock check and decrement should happen atomically.

A Redis Lua script is one way to achieve this because the check and decrement execute as one operation. Separate client-side `GET` and `DECRBY` calls can race when multiple requests access the same stock.

The Lua-script approach is a design recommendation; only claim it is implemented if the current source code explicitly uses and verifies it.

### 3. Reservation Expiry

A five-minute payment hold is a possible design. If a reservation expires, a worker or scheduled expiry process must release stock idempotently.

A TTL alone only expires a key; it does not automatically increment inventory. Expiry and payment success must be coordinated to prevent releasing stock for an order that has just been paid.

### 4. Asynchronous Processing and Idempotency

RabbitMQ separates request acceptance from background processing.

An HTTP `202 Accepted` response indicates that work was accepted for processing, not necessarily that the order is finally confirmed. Consumers should handle duplicate delivery safely, and retry/dead-letter behavior must be configured and verified before being described as active.

## Environment Configuration

The API containers receive these environment variables from Docker Compose:

| Variable | Purpose |
|---|---|
| `PORT` | API port (`5000` in Docker) |
| `INSTANCE_ID` | Instance label returned in `X-API-Instance` |
| `DB_HOST` | PostgreSQL hostname on the Docker network |
| `DB_PORT` | PostgreSQL port inside Docker (`5432`) |
| `DB_PASSWORD` | PostgreSQL password |
| `REDIS_URL` | Redis connection URL |
| `RABBITMQ_URL` | RabbitMQ connection URL |

For local development outside Docker, configure `server/.env` with local service addresses.

Do not commit real credentials or production secrets. The Compose credentials are for local/demo use only and must be replaced before deployment.

## Project Structure

```text
flashsale/
├── client/                 # Frontend application
├── server/
│   ├── server.js           # Express API
│   ├── worker.js           # Asynchronous checkout worker
│   ├── checkout-benchmark.js
│   ├── test-reservations.js
│   ├── package.json
│   ├── Dockerfile
│   └── .dockerignore
├── nginx/
│   └── default.conf        # Nginx load-balancing configuration
├── docker-compose.yml
└── schema.sql              # Database schema
```

## Local Development

### Run the API Outside Docker

Ensure PostgreSQL, Redis, and RabbitMQ are running and `server/.env` contains valid local connection settings.

```powershell
cd server
npm install
npm start
```

Run the worker in a separate terminal:

```powershell
cd server
npm run worker
```

### Run the Frontend

```powershell
cd client
npm install
npm run dev
```

Use the API base URL expected by the frontend configuration. For testing the Docker load balancer, use `http://localhost:8080`.

If the frontend uses a specific environment-variable name for its API URL, set the variable expected by the client code.

## Checkout Benchmarking

A benchmark script is available at `server/checkout-benchmark.js`.

Before running it, inspect its configured base URL and use test data or a test environment so requests do not unintentionally create orders or consume inventory in a live environment.

For a load-balanced benchmark, configure the script to use:

```javascript
const baseUrl = "http://localhost:8080";
```

Run it from the server directory using the command appropriate to the script:

```powershell
node .\checkout-benchmark.js
```

When reporting benchmark results, record:

- Concurrency and request count
- Latency and response times
- Accepted/rejected outcomes
- Final inventory and order state

A local benchmark is not evidence of production-scale throughput by itself.

## Troubleshooting

### Nginx Is Restarting

```powershell
docker compose logs --tail 100 nginx
docker compose restart nginx
```

Check `nginx/default.conf` syntax and ensure the upstream service names match `api1` and `api2`.

### API Cannot Connect to a Dependency

```powershell
docker compose ps
docker compose logs --tail 100 api1 api2 postgres redis rabbitmq
```

When running inside Docker, the API should use Docker service hostnames and internal container ports.

### Stop the Stack

```powershell
docker compose down
```

This stops and removes the Compose containers and network.

Avoid `docker compose down -v` unless you intentionally want to remove volumes and their stored data.

## Current Scope and Limitations

- Two API instances run behind one Nginx container on a single local Docker host.
- The setup demonstrates API horizontal replication and request distribution, not a multi-host production high-availability deployment.
- PostgreSQL, Redis, and RabbitMQ are shared dependencies.
- Production deployment would need secret management, TLS, monitoring, resource limits, backup/recovery planning, and failure testing.
- Do not claim Redis Cluster, Kafka, a Go checkout service, verified five-minute automatic stock release, or broker-level dead-lettering unless these features are implemented and tested.

## Security Notes

- Replace demo credentials before deployment.
- Keep `.env` files and secrets out of source control.
- Expose only the ports needed for the deployment environment.
- Use a dedicated test database and test inventory for load testing.

## License

Add the license and attribution details applicable to this project before public distribution.
