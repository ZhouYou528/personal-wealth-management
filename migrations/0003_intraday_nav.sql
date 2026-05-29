-- Add snap_hour column and change PK to (snap_date, snap_hour, account_id)
-- so intraday snapshots (hour 0-22) and end-of-day (hour 23) can coexist.
CREATE TABLE nav_snapshots_new (
  snap_date  TEXT    NOT NULL,
  snap_hour  INTEGER NOT NULL DEFAULT 23,
  account_id TEXT    NOT NULL DEFAULT '',
  value      REAL    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'cost',
  PRIMARY KEY (snap_date, snap_hour, account_id)
);

INSERT INTO nav_snapshots_new (snap_date, snap_hour, account_id, value, source)
SELECT snap_date, 23, account_id, value, source FROM nav_snapshots;

DROP TABLE nav_snapshots;
ALTER TABLE nav_snapshots_new RENAME TO nav_snapshots;
