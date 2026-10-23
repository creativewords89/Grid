# The `backup` service: PostgreSQL's own client tools (same major version as the database)
# plus rclone for the optional off-server copy.
FROM postgres:16-alpine
RUN apk add --no-cache rclone
COPY ops/backup.sh ops/restore.sh ops/backup-loop.sh /ops/
ENTRYPOINT ["/ops/backup-loop.sh"]
