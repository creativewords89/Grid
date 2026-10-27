# Restoring a backup

A restore **replaces** the Hub's database with the copy from a backup. Anything added or
changed after that backup is lost (imports, runs, settings, users), so only restore when
something has really gone wrong: the database was damaged, the server was rebuilt, or data
was deleted by mistake.

The Master Sheet and the Drive reports are in Google and are **not** part of the backup;
a restore doesn't change them. Leads imported after the backup are still in the Sheet, so
import those files again after restoring and the Hub matches them up.

All commands run on the server, in `/opt/gridrankers/cold-outreach/hub`.

## On the same server

1. **See which backups there are.** Each one is named by its date and time (UTC):

   ```sh
   docker compose exec backup /ops/restore.sh
   # Which backup? These are available:
   #   20261025-213000
   #   20261026-213000
   ```

2. **Stop the Hub** so nothing changes during the restore (the database and the backup
   service keep running). Stop the agents too, so none of them reports a run that the
   restored database doesn't know:

   ```sh
   docker compose stop caddy api scheduler
   ```

3. **Make a backup of how things are now**, in case you need to go back:

   ```sh
   docker compose exec backup /ops/backup.sh
   ```

4. **Restore** the one you chose. Type `RESTORE` when asked:

   ```sh
   docker compose exec backup /ops/restore.sh 20261026-213000
   ```

5. **Start the Hub again**, then the agents:

   ```sh
   docker compose up -d
   ```

6. **Check:** sign in, open the Overview, Runs and Import, and press each test button on
   Connections. Re-import any lead file uploaded after the backup.

## On a new server (the old one is gone)

1. Set up the new server with [deploy.md](deploy.md) steps 1–5, using the **same** `.env`
   (the copy you kept in a password manager). With a different `SECRET_KEY` the backup
   still restores, but every key in Connections must be entered again (agent tokens and
   passwords keep working).
2. Copy the backup into the backup volume. From the off-server copy:

   ```sh
   docker compose exec backup sh -c 'rclone copy "$BACKUP_TARGET" /data/backups'
   ```

   or from your own computer, with `scp` to the server and then
   `docker compose cp hub-….dump backup:/data/backups/`.
3. Continue from step 2 above. You don't need to create the Owner again: the restored
   database already has every account.
4. Point the DNS record at the new server's IP address (deploy.md step 3) and start the
   agents there (deploy.md step 7, with their existing tokens).

## Tested

`ops/restore-test.sh` restores the newest backup into a scratch database, compares every
table's row count with the live one, then drops the scratch copy. It runs in CI after the
end-to-end tests (on the database they filled: an Owner, a Google connection, an import,
an agent and its run) and can be run on the server at any time:

```sh
docker compose exec backup /ops/restore-test.sh
```

A backup that fails (for example, the database can't be reached) is recorded with its
reason in `last-backup.json`, and the Owners get an alert.
