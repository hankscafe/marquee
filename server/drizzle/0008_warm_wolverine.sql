CREATE TABLE `scheduled_picks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_by` integer NOT NULL,
	`kind` text NOT NULL,
	`day_of_week` integer,
	`time_of_day` text,
	`run_at` integer,
	`filters` text,
	`post_to_discord` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`last_pick_media_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_pick_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `users` ADD `jellyfin_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `emby_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_jellyfin_id_unique` ON `users` (`jellyfin_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_emby_id_unique` ON `users` (`emby_id`);