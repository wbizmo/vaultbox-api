# VaultBox API

VaultBox API is a secure cloud storage backend built with Fastify, Prisma, PostgreSQL, Redis, and JWT authentication.

The platform provides user accounts, storage plans, quota enforcement, file uploads, folder organization, signed download tokens, audit logging, administration tools, infrastructure monitoring, and billing-related account controls through a documented REST API.

---

## Features

### Authentication & Authorization

* User registration
* User login
* JWT authentication
* Password hashing with bcrypt
* Role-based access control
* Protected API routes
* Administrator privileges

### User Management

* User accounts
* Account status tracking
* Active accounts
* Suspended accounts
* Deleted accounts
* Current user profile endpoint

### Storage Plans

* Multiple storage tiers
* Plan subscriptions
* Quota allocation
* Storage usage tracking
* Storage limit enforcement

### File Management

* File uploads
* File listing
* File deletion
* File metadata tracking
* SHA256 checksum generation
* Upload audit logging
* Storage accounting

### Folder Management

* Folder creation
* Folder listing
* Folder renaming
* Folder deletion

### Secure Downloads

* Signed download tokens
* Expiring download links
* One-time token usage
* Download audit logging

### Administration

* User management
* Account suspension
* Account reactivation
* User deletion
* Storage reporting
* Audit log access

### Billing Simulation

* Failed payment simulation
* Automatic account suspension
* Account recovery workflow

### Infrastructure

* PostgreSQL database
* Redis integration
* Infrastructure health checks
* API rate limiting
* Swagger/OpenAPI documentation

---

## Architecture

VaultBox API follows a modular service-oriented architecture.

Core modules include:

* Authentication
* User Management
* Storage Plans
* Quota Enforcement
* File Management
* Folder Management
* Secure Downloads
* Billing
* Administration
* Audit Logging
* Infrastructure Monitoring

Data is stored in PostgreSQL through Prisma ORM while Redis provides infrastructure services such as caching and rate limiting.

---

## Technology Stack

### Backend

* Node.js
* Fastify
* Prisma ORM

### Authentication

* JWT
* bcrypt

### Database

* PostgreSQL
* Neon PostgreSQL

### Infrastructure

* Redis
* Upstash Redis

### Documentation

* Swagger
* OpenAPI

### Development

* Replit

---

## Project Structure

```
vaultbox-api/
│
├── prisma/
│   ├── schema.prisma
│   └── seed.js
│
├── src/
│   ├── lib/
│   ├── middleware/
│   ├── routes/
│   ├── app.js
│   └── server.js
│
├── storage/
│   └── uploads/
│
├── .env.example
├── package.json
└── README.md
```

---

## Storage Workflow

1. User authenticates using JWT.
2. User uploads a file.
3. Storage quota is validated against the assigned plan.
4. File metadata is stored in PostgreSQL.
5. File is written to storage.
6. Upload activity is recorded in audit logs.
7. User generates a signed download token.
8. Token expires automatically after the configured lifetime.
9. Download activity is recorded in audit logs.

---

## Security Features

* JWT authentication
* Role-based access control
* Password hashing
* Storage quota enforcement
* Account suspension controls
* Signed download tokens
* Token expiration
* Audit logging
* Infrastructure monitoring
* Rate limiting
* Request validation

---

## Demo Accounts

The database seeder automatically creates two accounts for testing.

### Administrator

```
Email: admin@vaultbox.dev
Password: Admin123!
```

Administrator capabilities:

* View all users
* Suspend users
* Reactivate users
* Delete users
* View audit logs
* View storage reports
* Access all administrative endpoints

### Standard User

```
Email: user@vaultbox.dev
Password: User123!
```

Standard user capabilities:

* Login
* Manage folders
* Upload files
* Delete files
* View storage quota
* Change storage plans
* Generate download tokens
* Simulate billing failures
* Access user endpoints

---

## API Modules

### Authentication

```
POST /auth/register
POST /auth/login
GET  /me
```

### Plans

```
GET   /plans
GET   /quota
PATCH /plans/:planId/subscribe
```

### Folders

```
POST   /folders
GET    /folders
PATCH  /folders/:id
DELETE /folders/:id
```

### Files

```
POST   /files/upload
GET    /files
DELETE /files/:id
```

### Downloads

```
POST /files/:id/download-token
GET  /download/:token
```

### Billing

```
POST /billing/simulate-failed-payment
```

### Administration

```
GET    /admin/users
PATCH  /admin/users/:id/suspend
PATCH  /admin/users/:id/reactivate
DELETE /admin/users/:id

GET    /admin/storage-report
GET    /admin/audit-logs
```

### Infrastructure

```
GET /health
GET /infra/health
```

### Documentation

```
GET /docs
```

---

## API Documentation

Interactive API documentation is available through Swagger UI.

Open:

```
http://localhost:4000/docs
```

Swagger provides:

* Complete endpoint list
* Request parameters
* Request bodies
* Authentication requirements
* Response schemas
* Interactive endpoint testing

All available API functionality can be explored directly through the Swagger interface.

---

## Testing the API

1. Seed the database:

   ```
   node prisma/seed.js
   ```

2. Start the application:

   ```
   npm run dev
   ```

3. Open Swagger:

   ```
   http://localhost:4000/docs
   ```

4. Login using either:

   ```
   admin@vaultbox.dev
   Admin123!
   ```

   or

   ```
   user@vaultbox.dev
   User123!
   ```

5. Copy the JWT token returned from login.

6. Click the "Authorize" button in Swagger.

7. Paste the JWT token.

8. Test protected endpoints directly from Swagger UI.

---

## Installation

Clone the repository:

```
git clone https://github.com/wbizmo/vaultbox-api.git
```

Move into the project directory:

```
cd vaultbox-api
```

Install dependencies:

```
npm install
```

Create an environment file:

```
cp .env.example .env
```

Generate Prisma client:

```
npx prisma generate
```

Run database migrations:

```
npx prisma migrate deploy
```

Seed demo data:

```
node prisma/seed.js
```

Start the development server:

```
npm run dev
```

---

## Environment Variables

```
PORT=4000
NODE_ENV=development

DATABASE_URL=
DIRECT_URL=

JWT_SECRET=
JWT_EXPIRES_IN=7d

APP_URL=http://localhost:4000

DOWNLOAD_TOKEN_EXPIRES_MINUTES=5

REDIS_URL=
REDIS_KEY_PREFIX=vaultbox
```

---

## Infrastructure Services

Recommended hosted services:

### Database

Neon PostgreSQL

### Redis

Upstash Redis

Use:

* DATABASE_URL for the pooled PostgreSQL connection.
* DIRECT_URL for Prisma migrations.

---

## Development Workflow

Generate Prisma client:

```
npx prisma generate
```

Create migrations:

```
npx prisma migrate dev
```

Apply migrations:

```
npx prisma migrate deploy
```

Seed database:

```
node prisma/seed.js
```

Start development server:

```
npm run dev
```

---

## Author

Williams Ashibuogwu

GitHub

```
https://github.com/wbizmo
```

---

## License

MIT License
