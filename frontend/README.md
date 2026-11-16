# CampusFind frontend

CampusFind is a campus lost-and-found board built with React and Vite.

## Run locally

1. Start the backend using the instructions in [backend/README.md](../backend/README.md).
2. Copy `.env.example` to `.env` if the backend API is not at `http://localhost:5000/api`, then set `VITE_API_BASE_URL` to the API base URL.
3. Run `npm install` and `npm run dev`.

The development server is available at `http://localhost:5173` by default. Configure the matching backend `CLIENT_ORIGINS` value when changing this origin.

## Build and checks

- `npm run lint`
- `npm run build`
