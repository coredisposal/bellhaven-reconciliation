CREATE TABLE `audits` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text,
	`event` text NOT NULL,
	`data` text NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`action` text NOT NULL,
	`option_id` text,
	`actor` text NOT NULL,
	`session_id` text NOT NULL,
	`note` text NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fixtures` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `locks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`started` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`step` integer NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`updated` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`case_key` text NOT NULL,
	`version` text NOT NULL,
	`run_id` text NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`started` text NOT NULL,
	`finished` text,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`csrf` text NOT NULL,
	`created` text NOT NULL,
	`last_request` integer DEFAULT 0 NOT NULL
);
