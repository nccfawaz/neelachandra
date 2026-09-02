-- 007_marketing.sql
-- Spec 6.5: the module that owns the public site. Pages with revisions,
-- packages with effective dating, services, showcase, FAQs, team,
-- testimonials, lead sources, campaigns, spend and SEO keywords.
--
-- What this migration does NOT do: it does not switch the public site over to
-- reading from these tables. The public pages stay as generated static HTML
-- under the design and content freeze (spec 3.2). These rows are the seeded
-- mirror of what the pages already say, so the phase 8 editor has a source
-- and the parity gate keeps guarding the rendered output.
--
-- site_packages rates are the four rates already printed on the packages page
-- in paise: 2299, 2699, 3099 and 3499 rupees per sqft.
--
-- site_testimonials is seeded empty. The live rating correction (CQ-1)
-- established 4.0 from 4 Google reviews and the review bodies are not in the
-- repository, so seeding text would be fabrication.

CREATE TABLE site_pages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(160) NOT NULL,
  title VARCHAR(200) NOT NULL,
  h1 VARCHAR(200) NULL,
  meta_description VARCHAR(320) NULL,
  canonical_path VARCHAR(200) NULL,
  og_image_file_id BIGINT UNSIGNED NULL,
  schema_types JSON NOT NULL,
  sitemap_priority DECIMAL(2,1) NOT NULL DEFAULT 0.5,
  sitemap_changefreq ENUM('always','hourly','daily','weekly','monthly','yearly','never')
    NOT NULL DEFAULT 'monthly',
  noindex TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  published_at DATETIME NULL,
  published_by BIGINT UNSIGNED NULL,
  content_json JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pages_slug (slug),
  KEY idx_pages_status (status),
  CONSTRAINT fk_pages_og FOREIGN KEY (og_image_file_id) REFERENCES files (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pages_publisher FOREIGN KEY (published_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE site_page_revisions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  page_id BIGINT UNSIGNED NOT NULL,
  revision_no INT UNSIGNED NOT NULL,
  content_json JSON NOT NULL,
  title VARCHAR(200) NOT NULL,
  meta_description VARCHAR(320) NULL,
  schema_types JSON NULL,
  changed_by BIGINT UNSIGNED NOT NULL,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  change_note VARCHAR(255) NULL,
  UNIQUE KEY uq_page_rev (page_id, revision_no),
  CONSTRAINT fk_rev_page FOREIGN KEY (page_id) REFERENCES site_pages (id) ON DELETE CASCADE,
  CONSTRAINT fk_rev_user FOREIGN KEY (changed_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE site_packages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  slug VARCHAR(80) NOT NULL,
  rate_per_sqft_paise BIGINT NOT NULL,
  is_most_popular TINYINT(1) NOT NULL DEFAULT 0,
  min_area_sqft DECIMAL(10,2) NULL,
  summary VARCHAR(300) NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_packages_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE projects
  ADD CONSTRAINT fk_projects_package FOREIGN KEY (package_id) REFERENCES site_packages (id) ON DELETE RESTRICT;

CREATE TABLE package_spec_groups (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  package_id BIGINT UNSIGNED NOT NULL,
  group_name VARCHAR(120) NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_psg (package_id, sort_order),
  CONSTRAINT fk_psg_package FOREIGN KEY (package_id) REFERENCES site_packages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE package_spec_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  group_id BIGINT UNSIGNED NOT NULL,
  label VARCHAR(160) NOT NULL,
  spec_value TEXT NOT NULL,
  item_id BIGINT UNSIGNED NULL,                -- the join that makes 6.4 rule 6 enforceable
  brand_options VARCHAR(255) NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_psl (group_id, sort_order),
  CONSTRAINT fk_psl_group FOREIGN KEY (group_id) REFERENCES package_spec_groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_psl_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE site_services (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  summary VARCHAR(300) NULL,
  body_json JSON NULL,
  icon VARCHAR(60) NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_services_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE site_showcase (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NULL,
  title VARCHAR(200) NOT NULL,
  client_display_name VARCHAR(180) NULL,
  location VARCHAR(140) NULL,
  built_up_area_display VARCHAR(60) NULL,
  project_type_display VARCHAR(120) NULL,
  scope_of_work TEXT NULL,
  client_sector VARCHAR(120) NULL,
  delivery_status VARCHAR(80) NULL,
  compliance_standards VARCHAR(255) NULL,
  cover_file_id BIGINT UNSIGNED NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  client_consent_on_file TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_showcase_published (is_published, sort_order),
  CONSTRAINT fk_showcase_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL,
  CONSTRAINT fk_showcase_cover FOREIGN KEY (cover_file_id) REFERENCES files (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE site_showcase_images (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  showcase_id BIGINT UNSIGNED NOT NULL,
  file_id BIGINT UNSIGNED NOT NULL,
  caption VARCHAR(200) NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ssi (showcase_id, sort_order),
  CONSTRAINT fk_ssi_showcase FOREIGN KEY (showcase_id) REFERENCES site_showcase (id) ON DELETE CASCADE,
  CONSTRAINT fk_ssi_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE site_faqs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  page_id BIGINT UNSIGNED NULL,                -- NULL means global
  question VARCHAR(300) NOT NULL,
  answer TEXT NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_faqs_page (page_id, sort_order),
  CONSTRAINT fk_faqs_page FOREIGN KEY (page_id) REFERENCES site_pages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE site_team (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  job_title VARCHAR(120) NULL,
  bio TEXT NULL,
  photo_file_id BIGINT UNSIGNED NULL,
  employee_id BIGINT UNSIGNED NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_team_published (is_published, sort_order),
  CONSTRAINT fk_team_photo FOREIGN KEY (photo_file_id) REFERENCES files (id) ON DELETE RESTRICT,
  CONSTRAINT fk_team_emp FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE site_testimonials (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  author_name VARCHAR(120) NOT NULL,
  author_location VARCHAR(120) NULL,
  project_id BIGINT UNSIGNED NULL,
  rating TINYINT NULL,
  body TEXT NOT NULL,
  source ENUM('google','direct','email','whatsapp') NOT NULL,
  source_url VARCHAR(300) NULL,
  collected_on DATE NULL,
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_testi_published (is_published),
  CONSTRAINT fk_testi_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lead_sources (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(120) NOT NULL,
  channel ENUM('organic','paid_search','paid_social','referral','direct',
    'walk_in','whatsapp','call','listing_site','other') NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_leadsrc_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE campaigns (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  channel ENUM('organic','paid_search','paid_social','referral','direct',
    'walk_in','whatsapp','call','listing_site','other') NOT NULL,
  platform VARCHAR(60) NULL,
  objective ENUM('leads','awareness','recruitment','remarketing') NOT NULL DEFAULT 'leads',
  target_geo VARCHAR(160) NULL,
  target_project_type VARCHAR(60) NULL,
  utm_source VARCHAR(60) NULL,
  utm_medium VARCHAR(60) NULL,
  utm_campaign VARCHAR(80) NULL,
  budget_paise BIGINT NULL,
  start_date DATE NULL,
  end_date DATE NULL,
  status ENUM('planned','active','paused','completed','cancelled') NOT NULL DEFAULT 'planned',
  owner_user_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_utm (utm_source, utm_medium, utm_campaign),
  KEY idx_campaign_status (status),
  CONSTRAINT fk_campaign_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_campaign_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE campaign_spend (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  campaign_id BIGINT UNSIGNED NOT NULL,
  spend_date DATE NOT NULL,
  amount_paise BIGINT NOT NULL,
  impressions INT UNSIGNED NULL,
  clicks INT UNSIGNED NULL,
  entry_mode ENUM('manual','api') NOT NULL DEFAULT 'manual',
  expense_id BIGINT UNSIGNED NULL,             -- FK expenses added in 009
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spend (campaign_id, spend_date),
  CONSTRAINT fk_spend_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,
  CONSTRAINT fk_spend_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE seo_keywords (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  keyword VARCHAR(160) NOT NULL,
  page_id BIGINT UNSIGNED NULL,
  target_city VARCHAR(80) NULL,
  search_volume INT UNSIGNED NULL,
  current_rank SMALLINT UNSIGNED NULL,
  last_checked_on DATE NULL,
  is_tracked TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_keyword_page (keyword, page_id),
  CONSTRAINT fk_kw_page FOREIGN KEY (page_id) REFERENCES site_pages (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed: the ten published pages, with the sitemap priorities and changefreq
-- values the live sitemap.xml already carries.
INSERT INTO site_pages (slug, title, canonical_path, schema_types, sitemap_priority, sitemap_changefreq, status, content_json) VALUES
  ('', 'Best Construction Company in Bengaluru', '/', '["WebPage","LocalBusiness","FAQPage"]', 1.0, 'weekly', 'published', '{"blocks":[]}'),
  ('construction-services-in-bengaluru', 'Construction Services in Bengaluru', '/construction-services-in-bengaluru', '["WebPage","Service"]', 0.9, 'monthly', 'published', '{"blocks":[]}'),
  ('construction-packages-in-bengaluru', 'Construction Packages in Bengaluru', '/construction-packages-in-bengaluru', '["WebPage","Product","FAQPage"]', 0.9, 'monthly', 'published', '{"blocks":[]}'),
  ('best-construction-company-in-bengaluru-projects', 'Our Projects', '/best-construction-company-in-bengaluru-projects', '["WebPage","CollectionPage"]', 0.8, 'monthly', 'published', '{"blocks":[]}'),
  ('best-construction-company-in-bengaluru', 'Best Construction Company in Bengaluru', '/best-construction-company-in-bengaluru', '["WebPage","LocalBusiness"]', 0.8, 'monthly', 'published', '{"blocks":[]}'),
  ('construction-company-in-tumkur', 'Construction Company in Tumkur', '/construction-company-in-tumkur', '["WebPage","LocalBusiness"]', 0.8, 'monthly', 'published', '{"blocks":[]}'),
  ('about-us', 'About Us', '/about-us', '["WebPage","AboutPage"]', 0.7, 'monthly', 'published', '{"blocks":[]}'),
  ('contact-us', 'Contact Us', '/contact-us', '["WebPage","ContactPage"]', 0.7, 'monthly', 'published', '{"blocks":[]}'),
  ('terms', 'Terms and Conditions', '/terms', '["WebPage"]', 0.3, 'yearly', 'published', '{"blocks":[]}'),
  ('privacy-policy', 'Privacy Policy', '/privacy-policy', '["WebPage"]', 0.3, 'yearly', 'published', '{"blocks":[]}');

-- Seed: the four packages at the rates the packages page prints today.
INSERT INTO site_packages (name, slug, rate_per_sqft_paise, is_most_popular, sort_order, effective_from) VALUES
  ('Silver', 'silver', 229900, 0, 10, '2026-04-01'),
  ('Platinum', 'platinum', 269900, 0, 20, '2026-04-01'),
  ('Gold', 'gold', 309900, 1, 30, '2026-04-01'),
  ('Diamond', 'diamond', 349900, 0, 40, '2026-04-01');

-- Seed: spec groups per package, matching the published grouping.
INSERT INTO package_spec_groups (package_id, group_name, sort_order)
SELECT p.id, g.group_name, g.sort_order
FROM site_packages p
CROSS JOIN (
  SELECT 'Design and approvals' AS group_name, 10 AS sort_order
  UNION ALL SELECT 'Foundation and structure', 20
  UNION ALL SELECT 'Masonry and plastering', 30
  UNION ALL SELECT 'Flooring and tiling', 40
  UNION ALL SELECT 'Electrical', 50
  UNION ALL SELECT 'Plumbing and sanitaryware', 60
  UNION ALL SELECT 'Painting', 70
  UNION ALL SELECT 'Doors and windows', 80
) AS g;

-- Seed: the brand promise lines the packages page publishes, attached to the
-- structure group of every package and joined to the item master so 6.4
-- rule 6 has something to check against.
INSERT INTO package_spec_lines (group_id, label, spec_value, item_id, brand_options, sort_order)
SELECT g.id, v.label, v.spec_value, i.id, v.brand_options, v.sort_order
FROM package_spec_groups g
JOIN site_packages p ON p.id = g.package_id
JOIN (
  SELECT 'Cement' AS label, 'OPC 53 grade cement' AS spec_value, 'MAT-CEM-OPC53' AS item_code,
         'UltraTech / ACC / Birla Super' AS brand_options, 10 AS sort_order, 'Foundation and structure' AS grp
  UNION ALL SELECT 'Steel', 'Fe500D or Fe550D TMT reinforcement', 'MAT-STL-FE500D', 'JSW Neo / Tata Tiscon / Indus', 20, 'Foundation and structure'
  UNION ALL SELECT 'Aggregate', '20 mm and 12 mm graded jelly with M sand', 'MAT-AGG-JELLY20', NULL, 30, 'Foundation and structure'
  UNION ALL SELECT 'Waterproofing', 'Integral and coating waterproofing at wet areas and terrace', 'MAT-CHM-WPROOF', 'Fosroc / Dr. Fixit', 40, 'Foundation and structure'
  UNION ALL SELECT 'Tiles', 'Vitrified tiles for living and bedrooms', 'MAT-FIN-TILE', 'Kajaria / Somany', 10, 'Flooring and tiling'
  UNION ALL SELECT 'Wiring', 'FR PVC insulated copper wiring in concealed conduit', 'MAT-ELE-WIRE', 'Finolex', 10, 'Electrical'
  UNION ALL SELECT 'Switchgear', 'Modular switches, sockets and MCB distribution board', 'MAT-ELE-SWITCH', 'Havells / Legrand / Anchor', 20, 'Electrical'
  UNION ALL SELECT 'Sanitaryware and CP fittings', 'WC, wash basin, taps and shower fittings', 'MAT-FIN-SANITARY', 'Jaquar / Hindware', 10, 'Plumbing and sanitaryware'
  UNION ALL SELECT 'Water lines', 'CPVC hot and cold water lines with PVC SWR drainage', 'MAT-PLB-CPVC', NULL, 20, 'Plumbing and sanitaryware'
  UNION ALL SELECT 'Interior paint', 'Two coats putty, primer and acrylic emulsion', 'MAT-FIN-PAINT-INT', 'Asian Paints', 10, 'Painting'
  UNION ALL SELECT 'Exterior paint', 'Weatherproof exterior emulsion', 'MAT-FIN-PAINT-EXT', 'Asian Paints SmartCare', 20, 'Painting'
) AS v ON v.grp = g.group_name
LEFT JOIN items i ON i.code = v.item_code;

-- Seed: the six services the services page publishes.
INSERT INTO site_services (slug, name, summary, sort_order) VALUES
  ('residential-construction', 'Residential construction', 'Independent houses, villas and apartment blocks built end to end.', 10),
  ('commercial-construction', 'Commercial construction', 'Offices, retail and institutional buildings.', 20),
  ('industrial-construction', 'Industrial construction', 'Factory sheds, machine foundations and industrial civil works.', 30),
  ('interior-fitout', 'Interior fitout', 'Turnkey interiors for homes and workspaces.', 40),
  ('renovation', 'Renovation and remodelling', 'Structural repair, extension and modernisation of existing buildings.', 50),
  ('equipment-rental', 'Construction equipment rental', 'Earthmoving, concreting and access equipment on hire.', 60);

-- Seed: the team the site's own structured data names.
INSERT INTO site_team (name, job_title, sort_order, is_published) VALUES
  ('Chandrashekar T', 'Founder', 10, 1),
  ('Sushma N', 'Operations Analyst', 20, 1),
  ('Vinay', 'Procurement Lead', 30, 1),
  ('Naveen Kumar', 'Technical Advisor', 40, 1);

-- Seed: lead sources, matching the channels the site actually receives
-- enquiries through today.
INSERT INTO lead_sources (code, name, channel) VALUES
  ('WEBSITE', 'Website contact form', 'organic'),
  ('GOOGLE_ORGANIC', 'Google organic search', 'organic'),
  ('GOOGLE_ADS', 'Google Ads', 'paid_search'),
  ('META_ADS', 'Meta Ads', 'paid_social'),
  ('WHATSAPP', 'WhatsApp enquiry', 'whatsapp'),
  ('PHONE', 'Phone call', 'call'),
  ('REFERRAL_CLIENT', 'Referral from past client', 'referral'),
  ('REFERRAL_STAFF', 'Referral from staff', 'referral'),
  ('WALK_IN', 'Walk in', 'walk_in'),
  ('LISTING', 'Listing site', 'listing_site'),
  ('OTHER', 'Other', 'other');
