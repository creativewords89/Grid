# Putting the Agent Hub on the server

This guide is for someone who is comfortable copying commands into a terminal but isn't a
developer. Every command goes into the server's terminal unless it says otherwise. Lines
starting with `#` are explanations; you don't need to type them.

You need about 45 minutes the first time. Updates later take five minutes.

**The Answer Engine already runs on our server?** Then follow
[Next to the Answer Engine](#next-to-the-answer-engine-same-server) at the end instead of
steps 1–5; steps 6–10 are the same.

**Never paste API keys or passwords into a chat, an email or a ticket.** The Hub's own
settings file (`.env`, step 4) fills itself in; every service key (DataForSEO, Google,
email, Telegram) is entered in the website (step 6), where it is stored encrypted.

---

## 1. Get the server

1. An **Ubuntu 24.04** server with a **US IP address** (the agents look at US businesses'
   websites and Google results, which must see a US visitor). 2 vCPU, 4 GB RAM and 50 GB disk
   is enough for the Hub and the first agents.
2. Add your **SSH key** while creating it and write down its **IP address**.
3. Switch on the provider's **weekly snapshots** if it has them.

> **One website owns ports 80 and 443.** If the Answer Engine already runs on this server,
> it owns them: install the Hub next to it as described in
> [Next to the Answer Engine](#next-to-the-answer-engine-same-server).

Connect to the server from your own computer:

```sh
ssh root@YOUR.SERVER.IP
```

Install Docker (skip this if the server came with Docker):

```sh
curl -fsSL https://get.docker.com | sh
```

## 2. Lock the server down

```sh
# Firewall: only SSH and the website are reachable.
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw --force enable

# Sign in with your SSH key only (no passwords).
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# Install security updates automatically.
apt-get update && apt-get install -y unattended-upgrades git
dpkg-reconfigure -f noninteractive unattended-upgrades
```

Before you close this terminal, open a **second** terminal on your computer and check that
`ssh root@YOUR.SERVER.IP` still lets you in. If it doesn't, fix it from the first terminal.

## 3. Point the web address at the server

In the DNS settings of `gridrankers.com`, add an **A record**:

| Name  | Type | Value          |
|-------|------|----------------|
| `hub` | A    | YOUR.SERVER.IP |

It can take up to an hour to work. Check it from your computer with
`ping hub.gridrankers.com`: it should show the server's IP.

## 4. Download the Hub and make its settings file

Copy these lines into the server's terminal. The last command makes the settings file and
fills in long random passwords by itself, so there is nothing to type.

```sh
cd /opt
git clone https://github.com/creativewords89/Grid.git gridrankers
cd gridrankers/cold-outreach/hub
cp .env.example .env && \
sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$(openssl rand -hex 32)|" .env && \
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env && \
chmod 600 .env
```

If the repository is private, GitHub asks for a username and a password: use a
**fine-grained personal access token** with read access to the repository as the password
(GitHub → Settings → Developer settings).

The web address is already set to `hub.gridrankers.com`. To use another one, change
`APP_DOMAIN` and `APP_URL` in `.env` (`nano .env`; save with **Ctrl+O**, **Enter**, leave
with **Ctrl+X**).

**Keep a copy of `.env` somewhere safe** (a password manager). Whoever has `SECRET_KEY` can
read the stored keys; if it is lost or changed, every key must be entered again in
Connections, and a backup can only be restored with the same `.env`.

## 5. Start it

```sh
docker compose up -d --build
```

The first time takes several minutes. Then check that everything runs:

```sh
docker compose ps                      # every line should say "running" or "healthy"
curl -s https://hub.gridrankers.com/api/health
# {"status":"ok","version":"0.1.0","checks":{"database":"ok"}}
```

If the address doesn't load, wait a few minutes: Caddy fetches the HTTPS certificate on its
first start, and the DNS record (step 3) must already work.

## 6. Create your account and connect the services, in the browser

1. Get the one-time setup code (it proves you're the server's administrator, so nobody else
   can claim the new site first):

   ```sh
   docker compose exec api python -m app.cli setup-code
   ```

2. Open **https://hub.gridrankers.com**. It shows **Create the Owner account**: enter the
   setup code, your name, email and a password (at least 10 characters).
3. You land on **Connections**. For each service, fill it in, press **Save**, then the test
   button next to it:

   | Service | What to enter | Then press |
   |---|---|---|
   | **DataForSEO** | the API login and password from app.dataforseo.com → API Access | **Test and show balance** |
   | **Google (Sheets and Drive)** | the service account's JSON key file; the Master Sheet's link; the Drive folder's link. Share the Sheet and the folder with the service account's email as **Editor** first | **Test the Sheet and folder** |
   | **PageSpeed Insights** | an API key from Google Cloud → APIs & Services → Credentials | **Test the key** |
   | **Email (SMTP)** | your email provider's server, port (587), username, password and From address | **Send a test email** |
   | **Telegram alerts** | a bot token from @BotFather (`/newbot`). Add the bot to your alerts group and send any message there first | **Test and find the group** |

   After saving, a key shows only its last characters. To change it, enter the new one; to
   stop using it, press **Remove**.
4. **Overview** → set the total daily budget, the time zone, and the alert settings.
5. **Users** → invite the team (Admins can run things; Viewers can only look).
6. **Import** → upload the first lead file, check the preview and send it to the Master
   Sheet.

## 7. Start an agent

Each agent runs in its own container on this server and talks to the Hub over the Hub's
private Docker network, `agent-hub`, at `http://api:8000`. Nothing about agents is opened
to the internet.

1. **Agents → + Add agent**: give it a name and a key (for example `gbp-audit`). Copy the
   token it shows: it is shown only once (an Owner can make a new one later).
2. Start the agent with that token. Each agent's own guide gives the exact command; it
   always has these two settings and joins the `agent-hub` network:

   ```sh
   HUB_URL=http://api:8000
   AGENT_TOKEN=hub_agent_…        # the token from step 1
   ```

   To try the Hub with the **demo agent** (it does no real work):

   ```sh
   cd /opt/gridrankers/cold-outreach
   docker run -d --name demo-agent --restart unless-stopped --network agent-hub \
     -e HUB_URL=http://api:8000 -e AGENT_TOKEN=hub_agent_PASTE_IT_HERE \
     -v "$PWD/agents/demo:/agent:ro" python:3.12-slim python /agent/agent.py
   ```

3. Back on **Agents**, the card says **Connected** within a minute. Check its **Settings**,
   switch it **on**, and press **Run now** to try it. **Runs** shows how it went. Remove the
   demo agent afterwards with `docker rm -f demo-agent` (and switch it off in the Hub).

## 8. Backups

The database is backed up every night at 03:30 Dhaka time (`BACKUP_TIME=21:30` UTC in
`.env`) and kept 14 days on the server. If a backup fails, or none was made for a day and
a half, the Owners get an alert (email and Telegram).

Make one now, and prove it can be restored (into a scratch copy; the live database isn't
touched):

```sh
docker compose exec backup /ops/backup.sh
docker compose exec backup /ops/restore-test.sh
# restore test passed: 16 tables and … rows came back the same
```

**Copy backups off the server** (recommended: if the server is lost, so are backups kept on
it). Create a bucket with a storage provider supported by rclone (for example Backblaze B2),
then add to `.env`:

```sh
BACKUP_TARGET=b2:gridrankers-hub-backups
RCLONE_CONFIG_B2_TYPE=b2
RCLONE_CONFIG_B2_ACCOUNT=<the key ID>
RCLONE_CONFIG_B2_KEY=<the application key>
```

and restart the backup service: `docker compose up -d backup`. After the next backup,
`docker compose exec backup cat /data/backups/last-backup.json` says `"off_server": true`.

Restoring a backup is explained in [restore.md](restore.md).

## 9. Updating to a new version

```sh
cd /opt/gridrankers/cold-outreach/hub
git pull
docker compose up -d --build
```

Database changes are applied automatically when the Hub starts. Check `docker compose ps`
afterwards.

## 10. When something goes wrong

```sh
docker compose ps                         # what is running
docker compose logs --tail 100 api        # the website's log (one JSON object per line)
docker compose logs --tail 100 scheduler  # schedules, timeouts, alerts
docker compose logs --tail 100 backup
docker compose restart api scheduler      # restart the Hub (the database keeps running)
```

Every page request has an id, returned in the `X-Request-ID` header; search the API log for
it (`docker compose logs api | grep THE_ID`) to find what happened. Logs never contain keys,
passwords or lead data.

If you forget the Owner password and no other Owner can reset it:

```sh
docker compose exec api python -m app.cli create-owner --email new-you@gridrankers.com --name "Your Name"
```

makes a new Owner account with an email that has no account yet (it asks for the password
twice). Sign in with it, then reset the old account's password on **Users**.

## Next to the Answer Engine (same server)

Our Hostinger VPS (KVM 1, US location) already runs `answers.gridrankers.com`. The Hub goes
into its own folder with its own database, backups and settings; only the website traffic
is shared: the Answer Engine's Caddy, which owns ports 80 and 443, gets the certificate for
`hub.gridrankers.com` and passes its visitors on to the Hub. Nothing in the Answer Engine's
data or settings changes.

These steps replace steps 1–5 above. The repository on the server must have this version
(with `hub/docker-compose.shared.yml`) on the branch the server uses.

**1. Add swap memory** (once). KVM 1 has 4 GB of memory; swap is a safety margin so a busy
moment slows things down instead of stopping a service:

```sh
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h                                # "Swap:" shows 2.0Gi
```

(Skip it if `free -h` already shows swap.) When the Website agent arrives, which runs a
real browser, upgrade the VPS to **KVM 2**; Hostinger keeps the data.

**2. Point the web address at the server:** step 3 above (the `hub` A record, with the
same IP address as `answers`).

**3. Get the new version and make the Hub's settings file:**

```sh
cd /opt/gridrankers
git pull
cd cold-outreach/hub
cp .env.example .env && \
sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$(openssl rand -hex 32)|" .env && \
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env && \
sed -i "s|^#COMPOSE_FILE=|COMPOSE_FILE=|; s|^#ANSWERS_NETWORK=|ANSWERS_NETWORK=|" .env && \
chmod 600 .env
```

The last `sed` switches on "next to the Answer Engine". Check the Answer Engine's network
name, which the Hub joins:

```sh
docker network ls | grep answer       # should list answer-engine_default
```

If it shows another name, put it in `.env` as `ANSWERS_NETWORK=` (`nano .env`). Keep a copy
of `.env` in a password manager, as in step 4 above.

**4. Start the Hub:**

```sh
docker compose up -d --build
docker compose ps                     # every line "running" or "healthy"; caddy has no ports
```

**5. Tell the Answer Engine's Caddy about the Hub** (the Answer Engine's site is down for
a few seconds while its Caddy restarts):

```sh
cd /opt/gridrankers/answer-engine
cp caddy/sites/hub.caddy.example caddy/sites/hub.caddy
docker compose up -d --build caddy
docker compose logs --tail 20 caddy   # "certificate obtained successfully" for hub.gridrankers.com
```

**6. Check both sites:**

```sh
curl -s https://hub.gridrankers.com/api/health       # {"status":"ok",...}
curl -s https://answers.gridrankers.com/api/health   # still ok
```

Then continue with step 6 above (create the Owner account). Commands for the Hub
(`docker compose …`) are always run in `/opt/gridrankers/cold-outreach/hub`, and for the
Answer Engine in `/opt/gridrankers/answer-engine`. Agents (step 7) join the Hub's own
network, `agent-hub`, as described there.

**Updating:** `git pull` in `/opt/gridrankers`, then `docker compose up -d --build` in
the folder of each app that changed. If the Hub is stopped, `hub.gridrankers.com` shows an
error page; the Answer Engine keeps working.
