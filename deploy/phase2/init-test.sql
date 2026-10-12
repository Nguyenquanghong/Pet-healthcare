-- Disposable fixture only. Never execute against an existing/demo server.
CREATE ROLE p2_core LOGIN PASSWORD 'p2_core_fixture_only' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE p2_clinic LOGIN PASSWORD 'p2_clinic_fixture_only' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE p2_notification LOGIN PASSWORD 'p2_notification_fixture_only' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE p2_core_test OWNER p2_core;
CREATE DATABASE p2_clinic_test OWNER p2_clinic;
CREATE DATABASE p2_notification_test OWNER p2_notification;
REVOKE CONNECT ON DATABASE p2_core_test FROM PUBLIC;
REVOKE CONNECT ON DATABASE p2_clinic_test FROM PUBLIC;
REVOKE CONNECT ON DATABASE p2_notification_test FROM PUBLIC;
GRANT CONNECT ON DATABASE p2_core_test TO p2_core;
GRANT CONNECT ON DATABASE p2_clinic_test TO p2_clinic;
GRANT CONNECT ON DATABASE p2_notification_test TO p2_notification;
\connect p2_core_test
CREATE TABLE p2_test_marker (marker text PRIMARY KEY);
INSERT INTO p2_test_marker VALUES ('pet-phase2-p1-test:core:v1');
GRANT SELECT ON p2_test_marker TO p2_core;
\connect p2_clinic_test
CREATE TABLE p2_test_marker (marker text PRIMARY KEY);
INSERT INTO p2_test_marker VALUES ('pet-phase2-p1-test:clinic:v1');
GRANT SELECT ON p2_test_marker TO p2_clinic;
\connect p2_notification_test
CREATE TABLE p2_test_marker (marker text PRIMARY KEY);
INSERT INTO p2_test_marker VALUES ('pet-phase2-p1-test:notification:v1');
GRANT SELECT ON p2_test_marker TO p2_notification;
