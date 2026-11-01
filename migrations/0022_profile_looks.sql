-- Every person gets a look: a shape and a colour (keys from src/lib/looks.ts). Each pair belongs
-- to one person. Nap assigns them on first use, oldest profile first.
-- display_name NULL now means "has not picked a name yet": Nap sends them to /welcome.
ALTER TABLE profiles ADD COLUMN shape TEXT;
ALTER TABLE profiles ADD COLUMN color TEXT;
CREATE UNIQUE INDEX profiles_look ON profiles (shape, color)
  WHERE shape IS NOT NULL AND color IS NOT NULL;
