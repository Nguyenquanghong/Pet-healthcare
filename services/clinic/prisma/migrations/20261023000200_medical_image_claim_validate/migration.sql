-- AQ-09: validate the claim CHECK in its own transaction. VALIDATE CONSTRAINT takes
-- SHARE UPDATE EXCLUSIVE, so the scan over existing images does not block traffic.
ALTER TABLE "medical_images" VALIDATE CONSTRAINT "medical_images_content_check";
