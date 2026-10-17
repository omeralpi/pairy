CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_public_key_users_public_key_fk" FOREIGN KEY ("public_key") REFERENCES "public"."users"("public_key") ON DELETE no action ON UPDATE no action;