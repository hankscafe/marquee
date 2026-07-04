ALTER TABLE `polls` ADD `discord_message_id` text;--> statement-breakpoint
ALTER TABLE `polls` ADD `discord_channel_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `discord_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_discord_id_unique` ON `users` (`discord_id`);