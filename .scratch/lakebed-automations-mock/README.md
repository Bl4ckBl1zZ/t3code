# automations-mock

Run this Lakebed capsule:

```sh
npx lakebed dev
```

The starter app includes two client routes:

- `/`: the todo list.
- `/status`: a page that calls the `GET /api/status` endpoint.

You can also call the endpoint directly:

```sh
curl http://localhost:3000/api/status
```

The capsule includes `favicon.svg`. Replace it, add `favicon.ico`, or set `favicon: "assets/icon.svg"` in `server/index.ts`.
