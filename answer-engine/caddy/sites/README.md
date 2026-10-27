# Other sites served by this Caddy

The Answer Engine's Caddy owns ports 80 and 443 on the server. Another app on the same
server (the Agent Hub) doesn't open those ports itself: it joins this stack's network,
and a file here tells Caddy to get its HTTPS certificate and pass its visitors on.

To serve the Agent Hub (`cold-outreach/hub/ops/deploy.md`, "Next to the Answer Engine"):

```sh
cp caddy/sites/hub.caddy.example caddy/sites/hub.caddy
docker compose up -d --build caddy
```

Only `*.caddy` files are read; they stay on the server (`.gitignore`). Remove the file and
run the same `docker compose up` command to stop serving the site.
