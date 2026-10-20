ALTER TABLE `polls` ADD `public_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `polls_public_token_unique` ON `polls` (`public_token`);--> statement-breakpoint
ALTER TABLE `users` ADD `guest_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_guest_id_unique` ON `users` (`guest_id`);--> statement-breakpoint
ALTER TABLE `votes` ADD `voter_name` text;