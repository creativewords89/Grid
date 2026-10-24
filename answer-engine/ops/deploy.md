# Putting the Answer Engine on the Hostinger VPS

This guide is for someone who is comfortable copying commands into a terminal but isn't a
developer. Every command goes into the server's terminal unless it says otherwise. Lines
starting with `#` are explanations; you don't need to type them.

You need about an hour the first time. Updates later take five minutes.

**Never paste API keys or passwords into a chat, an email or a ticket.** They go in one place
only: the `.env` file on the server (step 4).

---

## 1. Get the server

1. In Hostinger, buy a **VPS KVM 1** (1 vCPU, 4 GB RAM, 50 GB disk) or bigger.
2. Choose the template **Ubuntu 24.04 with Docker** (it is listed under "OS with
   application"). If you pick plain Ubuntu 24.04 instead, install Docker with the commands
   in the box below.
3. During setup, add your **SSH key** (Hostinger's help explains how to make one). Write
   down the server's **IP address**.
4. In the VPS settings, switch on **weekly snapshots** (Hostinger keeps them for you).

> Only for plain Ubuntu (skip this if you chose the Docker template):
>
> ```sh
> curl -fsSL https://get.docker.com | sh
> ```

Connect to the server from your own computer:

```sh
ssh root@YOUR.SERVER.IP
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

| Name      | Type | Value               |
|-----------|------|---------------------|
| `answers` | A    | YOUR.SERVER.IP      |

It can take up to an hour to work. Check it from your computer with
`ping answers.gridrankers.com`: it should show the server's IP.

## 4. Download the app and fill in its settings

```sh
cd /opt
git clone https://github.com/creativewords89/Grid.git gridrankers
cd gridrankers/answer-engine
cp .env.example .env
nano .env
```

If the repository is private, GitHub asks for a username and a password: use a
**fine-grained personal access token** with read access to the repository as the password
(GitHub → Settings → Developer settings). If the app moves to its own repository (open
decision 4), use that address and folder instead.

`nano` is a simple editor: move with the arrow keys, save with **Ctrl+O** then **Enter**,
leave with **Ctrl+X**. Fill in at least:

| Setting | What to put |
|---|---|
| `APP_DOMAIN`, `APP_URL` | `answers.gridrankers.com` and `https://answers.gridrankers.com` |
| `SECRET_KEY` | a long random text. Make one with `openssl rand -base64 48` |
| `POSTGRES_PASSWORD` | another long random text (`openssl rand -base64 32`) |
| `ANTHROPIC_API_KEY` | from console.anthropic.com → API keys |
| `PINECONE_API_KEY` | from app.pinecone.io → API keys |
| `TELEGRAM_BOT_TOKEN` | from @BotFather in Telegram (`/newbot`) |
| `TELEGRAM_WEBHOOK_SECRET` | another random text (`openssl rand -hex 24`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | from your email provider (for invites, password resets and notifications) |

Leave the model settings as they are until the evaluation (section 9) says otherwise.
`BACKUP_TARGET` is for the off-server copy of backups (section 7); it can wait.

Protect the file so only the server's administrator can read it:

```sh
chmod 600 .env
```

## 5. Start it

```sh
docker compose up -d --build
```

The first time takes several minutes. Then check that everything runs:

```sh
docker compose ps                      # every line should say "running" or "healthy"
curl -s https://answers.gridrankers.com/api/health
# {"status":"ok","version":"0.1.0","checks":{"database":"ok"}}
```

If the address doesn't load, wait a few minutes: Caddy fetches the HTTPS certificate on
its first start, and the DNS record (step 3) must already work.

## 6. One-time setup

```sh
# The first Owner (you'll be asked for a password, at least 12 characters).
docker compose exec api python -m app.cli create-owner --email you@gridrankers.com --name "Your Name"

# Create the Pinecone index. It prints a "host"; you may add it to .env as PINECONE_HOST.
docker compose exec api python -m app.cli setup-pinecone

# Connect the Telegram bot to the app.
docker compose exec api python -m app.cli setup-telegram
```

Then, in the browser at https://answers.gridrankers.com:

1. Sign in with the Owner account.
2. **Users** → invite the reviewers and staff.
3. Add the bot to your **private reviewers' group** in Telegram, then choose that group in
   **Settings → Reviews** and press **Send a test message**.
4. Each reviewer: **Profile → Link Telegram**, and send the code to the bot.
5. **Documents** → upload the company documents.

## 7. Backups

Backups run by themselves every night at 02:30 (UTC): a copy of the database and of every
uploaded file, kept for 14 days on the server. **Settings → System** shows when the last
one ran and whether it worked; it turns red if one failed or none ran for a day and a half.

Make one now, to check it works:

```sh
docker compose exec backup /ops/backup.sh
```

**Copy backups off the server** (recommended: if the server is lost, so are backups kept on
it). Create a bucket with a storage provider supported by rclone (for example Backblaze B2),
then add to `.env`:

```sh
BACKUP_TARGET=b2:gridrankers-backups
RCLONE_CONFIG_B2_TYPE=b2
RCLONE_CONFIG_B2_ACCOUNT=<the key ID>
RCLONE_CONFIG_B2_KEY=<the application key>
```

and restart the backup service: `docker compose up -d backup`. Settings → System then says
"copied off the server" after each backup.

Restoring a backup is explained in [restore.md](restore.md).

## 8. Updating to a new version

```sh
cd /opt/gridrankers/answer-engine
git pull
docker compose up -d --build
```

Database changes are applied automatically when the app starts. Check
`docker compose ps` and Settings → System (the version number) afterwards.

## 9. Running the evaluation (choosing the threshold and model)

Every run costs real money (about $0.09 a question), so it only runs when you start it.

1. Upload the sample files in **Documents** and wait until they say Ready.
2. Write your questions in a spreadsheet with two columns, `question` and `expected` (leave
   `expected` empty, or put `-`, when the documents don't contain the answer). Save it as
   **CSV UTF-8**. `backend/eval/questions.example.csv` shows the format.
3. Copy it to the server from your own computer:
   `scp questions.csv root@YOUR.SERVER.IP:/opt/gridrankers/answer-engine/`
4. On the server:

```sh
cd /opt/gridrankers/answer-engine
docker compose run --rm --user root -v "$PWD:/eval" api python -m eval.run_eval /eval/questions.csv --out /eval/eval-results
# To compare a cheaper model without changing the app:
docker compose run --rm --user root -v "$PWD:/eval" api python -m eval.run_eval /eval/questions.csv --out /eval/eval-results --answer-model claude-sonnet-5-5
```

The report is in `eval-results/` (a `.md` file you can open in any text editor, or copy to
your computer with `scp`). It says how many answers were correct, the lowest safe threshold
and the best weights. Set the threshold and model in **Settings → Reviews** and
**Settings → Answering**.

## 10. When something goes wrong

| What you see | What to do |
|---|---|
| The site doesn't load | `docker compose ps`; if something isn't running: `docker compose up -d`. Then `docker compose logs --tail 100 caddy api` |
| Someone reports an error | Ask for the time it happened. Each request has an ID (the `X-Request-ID` header); find its log lines with `docker compose logs api \| grep <the ID>` |
| Documents stay "Processing" | `docker compose logs --tail 100 worker`; Settings → System shows failed jobs |
| Answers say the service is busy | Check the Anthropic key and credit at console.anthropic.com |
| Settings → System says backups failed | Its message says why; run `docker compose exec backup /ops/backup.sh` to try again |
| The disk is filling up | `df -h`; old backups are removed after 14 days (`BACKUP_KEEP_DAYS`); Docker logs are rotated automatically. `docker system prune` removes old images |

Logs are JSON lines, one per event. They never contain passwords, keys or question text.
