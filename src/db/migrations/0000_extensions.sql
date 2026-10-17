-- btree_gist is required by the bookings_no_overlap exclusion constraint (BR-11, A-04).
CREATE EXTENSION IF NOT EXISTS btree_gist;
