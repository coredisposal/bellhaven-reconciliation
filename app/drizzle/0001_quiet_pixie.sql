CREATE TABLE `facility_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`canonical_account_id` text,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`updated` text NOT NULL
);
