# CampusFind backend

## Run locally

1. Copy `.env.example` to `.env`.
2. Set `JWT_SECRET` to a unique random value of at least 32 characters.
3. Set `MONGO_URI` if MongoDB is not using the local default.
4. Run `npm install`, then `npm start`.

The backend creates partial unique indexes for student IDs and email addresses when it connects to MongoDB. Existing legacy user records without those fields are preserved and excluded from the indexes.

## Authentication modes

- `AUTH_MODE=local` is for local development only. It allows self-service accounts that claim a student ID and is not suitable for a public deployment.
- `AUTH_MODE=oidc` enables campus OpenID Connect SSO. Configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, and `OIDC_STUDENT_ID_CLAIM`. The provider must return a verified email and a positive numeric student ID claim. Register the redirect URI with the identity provider. Existing local accounts are not automatically linked; an administrator must verify and link them.
- Production startup requires `AUTH_MODE=oidc` and complete OIDC settings; the server will not start in local-account mode.
- Set `CLIENT_ORIGINS` to a comma-separated list of exact frontend origins, and set `FRONTEND_URL` to the frontend URL used after SSO.
- Authentication routes allow 100 attempts per 15 minutes in local development and 10 otherwise. Override `AUTH_RATE_LIMIT_MAX` and `AUTH_RATE_LIMIT_WINDOW_MS` in `.env` if needed; both must be positive integers. The local in-memory limiter resets when the backend process restarts.

## Item board API

- `GET /api/items` and `GET /api/items/search` accept `page`, `pageSize` (maximum 50), `reportType`, `category`, `location`, and `q` query parameters.
- List responses use `{ items, total, page, pageSize, totalPages }`. Public item records omit `reportedBy`; report ownership and identity details remain available only through authenticated account routes.
- Authenticated requests use the HTTP-only session cookie. The browser frontend is configured with `VITE_API_BASE_URL` in its `.env` file.

## Profile API

- `GET /api/profile` returns the signed-in user's account details and reports.
- `PATCH /api/profile` updates the signed-in user's name and email.

Both profile routes require the authenticated HTTP-only session cookie. Logging out invalidates the account's existing sessions.
