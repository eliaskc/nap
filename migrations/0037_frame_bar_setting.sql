-- The Nap bar is a setting on every nap now, also on naps in Nap's frame (kind 'artifact'), which
-- always had it until now. Some of those were moved from their own host with the bar off, and
-- would lose it. Turn it on for all of them, so nothing looks different until an owner turns it
-- off. Workers from before ignore `toolbar` on these naps.
UPDATE sites SET toolbar = 1 WHERE kind = 'artifact' AND toolbar = 0;
