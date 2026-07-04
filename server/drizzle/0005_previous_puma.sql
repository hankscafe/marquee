CREATE TABLE `tmdb_collection_parts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` integer NOT NULL,
	`tmdb_movie_id` text NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`poster_path` text,
	FOREIGN KEY (`collection_id`) REFERENCES `tmdb_collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tmdb_parts_unique` ON `tmdb_collection_parts` (`collection_id`,`tmdb_movie_id`);--> statement-breakpoint
CREATE TABLE `tmdb_collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tmdb_id` text NOT NULL,
	`name` text NOT NULL,
	`poster_path` text,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tmdb_collections_tmdb_id_unique` ON `tmdb_collections` (`tmdb_id`);--> statement-breakpoint
ALTER TABLE `media` ADD `tmdb_collection_checked` integer DEFAULT false NOT NULL;