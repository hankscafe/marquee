DROP INDEX `collections_rating_key_unique`;--> statement-breakpoint
ALTER TABLE `collections` ADD `source` text DEFAULT 'plex' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `collections_source_rating_key_unique` ON `collections` (`source`,`rating_key`);--> statement-breakpoint
DROP INDEX `media_rating_key_unique`;--> statement-breakpoint
ALTER TABLE `media` ADD `source` text DEFAULT 'plex' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `media_source_rating_key_unique` ON `media` (`source`,`rating_key`);