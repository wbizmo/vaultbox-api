# VaultBox API

VaultBox API is a secure cloud storage backend built with Fastify, Prisma, PostgreSQL, Redis, and JWT authentication.

The platform provides user accounts, storage plans, quota enforcement, file uploads, folder organization, signed download tokens, audit logging, administration tools, infrastructure monitoring, and billing-related account controls through a documented REST API.

---

## Live Demo

### Base URL

```text
https://vaultbox-api-ucff.onrender.com
```

### Important

The live deployment is hosted on Render's free tier.

If the API has been inactive for some time, Render may temporarily put the service to sleep.

Before testing any API endpoints:

1. Visit:

```text
https://vaultbox-api-ucff.onrender.com
```

2. Wait a few seconds for the service to wake up.

3. Open Swagger or begin testing endpoints.

Once awake, all endpoints function normally.

---

## Live API Documentation

Swagger UI:

```text
https://vaultbox-api-ucff.onrender.com/docs
```

Application Health:

```text
https://vaultbox-api-ucff.onrender.com/health
```

Infrastructure Health:

```text
https://vaultbox-api-ucff.onrender.com/infra/health
```

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

Data is stored in PostgreSQL through Prisma ORM while Redis provides infrastructure services such as caching, rate limiting, and operational support.

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
* Render

---

## Project Structure

```text
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

```text
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
* Access administrative endpoints

### Standard User

```text
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

```text
POST /auth/register
POST /auth/login
GET  /me
```

### Plans

```text
GET   /plans
GET   /quota
PATCH /plans/:planId/subscribe
```

### Folders

```text
POST   /folders
GET    /folders
PATCH  /folders/:id
DELETE /folders/:id
```

### Files

```text
POST   /files/upload
GET    /files
DELETE /files/:id
```

### Downloads

```text
POST /files/:id/download-token
GET  /download/:token
```

### Billing

```text
POST /billing/simulate-failed-payment
```

### Administration

```text
GET    /admin/users
PATCH  /admin/users/:id/suspend
PATCH  /admin/users/:id/reactivate
DELETE /admin/users/:id

GET    /admin/storage-report
GET    /admin/audit-logs
```

### Infrastructure

```text
GET /health
GET /infra/health
```

### Documentation

```text
GET /docs
```
## API Documentation

Interactive API documentation is available through Swagger UI.

### Local Development

```text
http://localhost:4000/docs
```

### Live Deployment

```text
https://vaultbox-api-ucff.onrender.com/docs
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

### Local Development

1. Run database migrations:

```bash
npx prisma migrate deploy
```

2. Seed demo data:

```bash
node prisma/seed.js
```

3. Start the server:

```bash
npm run dev
```

4. Open Swagger:

```text
http://localhost:4000/docs
```

5. Login using either:

```text
admin@vaultbox.dev
Admin123!
```

or

```text
user@vaultbox.dev
User123!
```

6. Copy the JWT token returned from login.

7. Click the Authorize button in Swagger.

8. Paste the JWT token.

9. Test protected endpoints.

---

### Testing the Live Deployment

Before testing, visit:

```text
https://vaultbox-api-ucff.onrender.com
```

This ensures the service is awake if Render has suspended the free-tier instance due to inactivity.

Then open:

```text
https://vaultbox-api-ucff.onrender.com/docs
```

Login using:

```text
admin@vaultbox.dev
Admin123!
```

or

```text
user@vaultbox.dev
User123!
```

Copy the returned JWT token and use Swagger's Authorize button to test protected routes.

---

## Installation

Clone the repository:

```bash
git clone https://github.com/wbizmo/vaultbox-api.git
```

Move into the project directory:

```bash
cd vaultbox-api
```

Install dependencies:

```bash
npm install
```

Create an environment file:

```bash
cp .env.example .env
```

Generate Prisma Client:

```bash
npx prisma generate
```

Run migrations:

```bash
npx prisma migrate deploy
```

Seed demo data:

```bash
node prisma/seed.js
```

Start development server:

```bash
npm run dev
```

---

## Environment Variables

```env
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

```text
Neon PostgreSQL
```

### Redis

```text
Upstash Redis
```

---

## Neon PostgreSQL Configuration

Use the pooled connection for application traffic:

```env
DATABASE_URL=postgresql://username:password@project-pooler.region.aws.neon.tech/database?sslmode=require
```

For migrations, use the direct connection:

```env
DIRECT_URL=postgresql://username:password@project.region.aws.neon.tech/database?sslmode=require
```

VaultBox has been tested successfully with Neon PostgreSQL in production.

---

## Upstash Redis Configuration

Use the TLS-enabled Redis URL:

```env
REDIS_URL=rediss://default:password@your-upstash-instance.upstash.io:6379
```

The `rediss://` protocol is required for secure connections.

VaultBox has been tested successfully with Upstash Redis in production.

---

## Render Deployment

VaultBox can be deployed on:

* Render
* Railway
* Fly.io
* VPS environments
* Docker hosts
* Any Node.js-compatible hosting platform

### Environment Variables

Configure the following variables in your hosting provider:

```env
DATABASE_URL=
DIRECT_URL=

REDIS_URL=

JWT_SECRET=
JWT_EXPIRES_IN=7d

APP_URL=

DOWNLOAD_TOKEN_EXPIRES_MINUTES=5
```

### Render Build Command

```bash
rm -rf node_modules package-lock.json && npm install --omit=dev
```

### Render Start Command

```bash
npm start
```

### After Deployment

Apply migrations:

```bash
npx prisma migrate deploy
```

Seed demo accounts:

```bash
node prisma/seed.js
```

---

## Development Workflow

Generate Prisma Client:

```bash
npx prisma generate
```

Create a migration:

```bash
npx prisma migrate dev --name migration_name
```

Apply migrations:

```bash
npx prisma migrate deploy
```

Seed demo data:

```bash
node prisma/seed.js
```

Start development server:

```bash
npm run dev
```

---

## Production Deployment Notes

Production deployment has been validated using:

* Render
* Neon PostgreSQL
* Upstash Redis

Verified functionality includes:

* User registration
* User login
* JWT authentication
* Protected routes
* Plan subscriptions
* Folder management
* Storage quota tracking
* Swagger documentation
* PostgreSQL connectivity
* Redis connectivity
* Health monitoring endpoints

Live deployment:

```text
https://vaultbox-api-ucff.onrender.com
```

Swagger documentation:

```text
https://vaultbox-api-ucff.onrender.com/docs
```

---

## Author

Williams Ashibuogwu

GitHub

```text
https://github.com/wbizmo
```

LinkedIn

```text
https://linkedin.com/in/wbizmo
```

Portfolio

```text
https://my-portfolio-website-three-ebon.vercel.app
```

---

## License

MIT License

Copyright (c) Williams Ashibuogwu

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software.
