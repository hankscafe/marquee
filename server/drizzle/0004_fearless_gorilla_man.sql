CREATE TABLE `user_watched` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`media_id` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_watched_unique` ON `user_watched` (`user_id`,`media_id`);--> statement-breakpoint
ALTER TABLE `media` ADD `imdb_id` text;--> statement-breakpoint
ALTER TABLE `media` ADD `tmdb_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `trakt_token` text;--> statement-breakpoint
ALTER TABLE `users` ADD `trakt_refresh` text;