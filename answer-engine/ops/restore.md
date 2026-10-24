# Restoring a backup

A restore **replaces** the database and every uploaded file with the copy from a backup.
Anything added or changed after that backup is lost, so only restore when something has
really gone wrong (the database was damaged, the server was rebuilt, or data was deleted
by mistake and the trash can't bring it back).

All commands run on the server, in `/opt/gridrankers/answer-engine`.

## On the same server

1. **See which backups there are.** Each one is named by its date and time (UTC):

   ```sh
   docker compose exec backup /ops/restore.sh
   # Which backup? These are available:
   #   20261022-023000
   #   20261023-023000
   ```

2. **Stop the app** so nobody changes anything during the restore (the database and the
   backup service keep running):

   ```sh
   docker compose stop caddy api worker
   ```

3. **Make a backup of how things are now**, in case you need to go back:

   ```sh
   docker compose exec backup /ops/backup.sh
   ```

4. **Restore** the one you chose. Type `RESTORE` when asked:

   ```sh
   docker compose exec backup /ops/restore.sh 20261023-023000
   ```

5. **Start the app again** and rebuild the search index, so Pinecone matches the restored
   documents:

   ```sh
   docker compose up -d
   ```

   Then sign in as the Owner and press **Settings → Knowledge base → Rebuild index**.

6. **Check:** sign in, open Documents and the Answer Log, and ask a question you know the
   answer to.

## On a new server (the old one is gone)

1. Set up the new server with [deploy.md](deploy.md) steps 1–5, using the **same** `.env`
   (keep a copy of it somewhere safe, such as a password manager).
2. Copy the backup files into the backup volume. From the off-server copy:

   ```sh
   docker compose exec backup sh -c 'rclone copy "$BACKUP_TARGET" /data/backups'
   ```

   or from your own computer, with `scp` to the server and then
   `docker compose cp db-….dump backup:/data/backups/` (and the same for `uploads-….tar.gz`).
3. Continue from step 2 above. You don't need to create the Owner again: the restored
   database already has every account.
4. Point the DNS record at the new server's IP address (deploy.md step 3).

## Tested

The restore was tested in build step 16: a backup of a working database (25 tables, with
documents, answers, reviews, verified answers and marketing threads) was restored into an
empty database, and every table's row count and every uploaded file matched the original.
A backup that fails (for example, the database can't be reached) is recorded with its
reason and shown in Settings → System.
