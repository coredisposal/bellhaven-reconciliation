CREATE INDEX `decisions_created_idx` ON `decisions` (`created`,`id`);--> statement-breakpoint
CREATE INDEX `decisions_proposal_created_idx` ON `decisions` (`proposal_id`,`created`,`id`);--> statement-breakpoint
CREATE INDEX `decisions_proposal_action_created_idx` ON `decisions` (`proposal_id`,`action`,`created`,`id`);