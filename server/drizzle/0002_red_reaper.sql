ALTER TABLE `media` ADD `rating` real;--> statement-breakpoint
ALTER TABLE `media` ADD `content_rating` text;--> statement-breakpoint
ALTER TABLE `media` ADD `directors` text;--> statement-breakpoint
ALTER TABLE `media` ADD `actors` text;--> statement-breakpoint
ALTER TABLE `media` ADD `watched` integer DEFAULT false NOT NULL;