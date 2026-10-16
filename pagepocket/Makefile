.PHONY: proto build dev up down migrate test test-integration lint format certs network-guard help

PROTO_DIR := proto
STUBS_DIR := shared/proto_generated
# All backend services: build + test targets (5.1 — api-gateway included so
# `make test` reaches its suite; the integration half runs via test-integration).
SERVICES := auth-service archive-service library-service search-service share-service api-gateway
# Only services with their own database/alembic directory (5.1: api-gateway
# has no alembic.ini, so `make migrate` must not visit it).
MIGRATE_SERVICES := auth-service archive-service library-service search-service share-service

COMPOSE := docker compose

# D13/4.6: the integration suite runs under a DEDICATED compose project
# (-p pagepocket-it) with its own network (docker-compose.it.yml), so it can
# never touch the prod-named project's volumes/containers and its
# `down -v` teardown is scoped to pagepocket-it_* resources only.
IT_PROJECT := pagepocket-it
IT_COMPOSE := $(COMPOSE) -p $(IT_PROJECT) -f docker-compose.yml -f docker-compose.it.yml

help:
	@echo "PagePocket Backend"
	@echo ""
	@echo "  make proto              Generate gRPC stubs from .proto files"
	@echo "  make build              Build all service Docker images"
	@echo "  make dev                Start the dev stack (docker compose up)"
	@echo "  make up                 Alias for dev"
	@echo "  make down               Stop the dev stack"
	@echo "  make migrate            Run Alembic migrations for all DB-backed services"
	@echo "  make test               Run pytest across all services + the"
	@echo "                          compose-contract render test"
	@echo "  make test-integration   Boot an ISOLATED compose stack (project"
	@echo "                          pagepocket-it) and run the gateway +"
	@echo "                          search MySQL integration suites (:8090)"
	@echo "  make lint               Run ruff linter"
	@echo "  make format             Run ruff + black formatter"
	@echo "  make certs              Generate mTLS CA + service certificates"

proto:
	@mkdir -p $(STUBS_DIR)
	python3 -m grpc_tools.protoc \
		-I $(PROTO_DIR) \
		--python_out=$(STUBS_DIR) \
		--grpc_python_out=$(STUBS_DIR) \
		$(PROTO_DIR)/*.proto
	@touch $(STUBS_DIR)/__init__.py
	@echo "Proto stubs generated in $(STUBS_DIR)"

# D13/4.7 (design note c): pagepocket_default is declared `external: true`
# in docker-compose.yml, so a fresh clone has nothing to attach to until the
# network exists. Guard dev/build (the guard is idempotent and cheap).
network-guard:
	@docker network inspect pagepocket_default >/dev/null 2>&1 || \
		{ echo "==> creating external network pagepocket_default (fresh-clone one-time setup)"; docker network create pagepocket_default; }

build: network-guard
	$(COMPOSE) build

dev: network-guard build
	$(COMPOSE) up -d

up: dev

down:
	$(COMPOSE) down

migrate:
	@for svc in $(MIGRATE_SERVICES); do \
		echo "Running migrations for $$svc..."; \
		$(COMPOSE) exec $$svc python -m alembic -c /app/alembic.ini upgrade head; \
	done

# 5.3: one subshell per service so a `cd` can never leak into the next
# iteration, python3 (not `python`), and failures propagate (each service
# runs regardless of the previous one's result; the target exits non-zero
# if any failed).
test:
	@status=0; \
	for svc in $(SERVICES); do \
		echo "==> Testing $$svc..."; \
		( cd services/$$svc && PYTHONPATH=../../shared:../../shared/proto_generated python3 -m pytest tests/ ) || status=1; \
	done; \
	echo "==> Compose-contract render test (pagepocket/tests)"; \
	( python3 -m pytest tests/test_compose_contract.py -q ) || status=1; \
	if [ $$status -ne 0 ]; then echo "==> make test: FAILURES detected" >&2; else echo "==> make test: all service suites passed"; fi; \
	exit $$status

# 5.1: boots the complete stack (mysql + redis + 5 services + gateway) and
# runs the gateway integration tests against the live gateway on
# 127.0.0.1:8090 — the same path CI uses, so the tests can never silently
# self-skip again (they skip only when the gateway is unreachable; here the
# wait loop guarantees it is up or the target fails).
#
# D13/4.6 (design note b): the stack runs under the ISOLATED project
# `pagepocket-it` (own network via docker-compose.it.yml), so a run can
# never reuse — or `down -v`-wipe — the prod-named project's volumes; the
# teardown at the bottom is scoped to pagepocket-it_* only. NB: the stack
# still publishes 127.0.0.1:{3306,50051..50055,8090}, so stop the dev/prod
# stack first; a port-bind conflict fails loudly at `up`.
#
# D13/4.5: after the health wait, SEARCH_TEST_DB_URL points the
# search-service FULLTEXT/CJK suite at the stack's MySQL (published
# 127.0.0.1:3306, root — docker-compose.yml) so those tests execute here
# and in CI instead of skipping forever.
test-integration:
	@status=0; \
	code=000; \
	mysql_pw="$${MYSQL_ROOT_PASSWORD:-$$([ -f .env ] && sed -n 's/^MYSQL_ROOT_PASSWORD=//p' .env | head -1)}"; \
	mysql_pw="$${mysql_pw:-pagepocket}"; \
	if ! $(IT_COMPOSE) up -d --build; then \
		echo "==> integration stack failed to start (attempt 1/2) — dumping ps + logs" >&2; \
		$(IT_COMPOSE) ps >&2 || true; \
		$(IT_COMPOSE) logs --tail=40 >&2 || true; \
		$(IT_COMPOSE) down -v --remove-orphans || true; \
		echo "==> retrying integration stack boot (attempt 2/2)" >&2; \
		if ! $(IT_COMPOSE) up -d --build; then \
			echo "==> integration stack failed twice — final logs" >&2; \
			$(IT_COMPOSE) ps >&2 || true; \
			$(IT_COMPOSE) logs --tail=40 >&2 || true; \
			$(IT_COMPOSE) down -v --remove-orphans || true; \
			exit 1; \
		fi; \
	fi; \
	for i in $$(seq 1 60); do \
		code=$$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/api/v1/health 2>/dev/null || echo 000); \
		if [ "$$code" = "200" ]; then break; fi; \
		sleep 2; \
	done; \
	warc=000; \
	if [ "$$code" != "200" ]; then \
		echo "==> gateway did not become healthy on 127.0.0.1:8090" >&2; \
		$(IT_COMPOSE) ps; \
		$(IT_COMPOSE) logs --tail=40 api-gateway; \
		status=1; \
	else \
		echo "==> gateway healthy — warming the service path (auth -> gateway -> gRPC -> archive)"; \
		wemail="warmup_$$(date +%s)@warmup.test"; \
		wpass="warmup-password-123"; \
		for i in $$(seq 1 30); do \
			reg=$$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8090/api/v1/auth/register -H 'Content-Type: application/json' -d '{"email":"'"$$wemail"'","password":"'"$$wpass"'","name":"Warmup"}' 2>/dev/null || echo 000); \
			if [ "$$reg" = "200" ] || [ "$$reg" = "201" ] || [ "$$reg" = "409" ]; then \
				wtok=$$(curl -s -X POST http://127.0.0.1:8090/api/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"'"$$wemail"'","password":"'"$$wpass"'"}' 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || echo); \
				warc=$$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/api/v1/archive/pages -H "Authorization: Bearer $$wtok" 2>/dev/null || echo 000); \
				if [ "$$warc" = "200" ] || [ "$$warc" = "402" ]; then echo "==> archive path warm (list_pages=$$warc)"; break; fi; \
			fi; \
			sleep 2; \
		done; \
		if [ "$$warc" != "200" ] && [ "$$warc" != "402" ]; then \
			echo "==> archive service path never warmed up (last=$$warc)" >&2; \
			$(IT_COMPOSE) ps; \
			$(IT_COMPOSE) logs --tail=40 archive-service api-gateway; \
			status=1; \
		fi; \
	fi; \
	if [ "$$status" -eq 0 ]; then \
		echo "==> running integration suite"; \
		( cd services/api-gateway && PAGEPOCKET_GATEWAY_URL=http://127.0.0.1:8090 python3 -m pytest tests/test_gateway_integration.py -v ) || status=1; \
		echo "==> running search-service MySQL integration suite (FULLTEXT/CJK, 4.5)"; \
		( cd services/search-service && SEARCH_TEST_DB_URL="mysql+pymysql://root:$${mysql_pw}@127.0.0.1:3306/search_db" PYTHONPATH=../../shared:../../shared/proto_generated python3 -m pytest tests/test_search_integration.py -v ) || status=1; \
	fi; \
	$(IT_COMPOSE) down -v --remove-orphans; \
	exit $$status

lint:
	ruff check services/ shared/ proto/

format:
	ruff check --fix services/ shared/
	black services/ shared/

# 7.3: canonical cert names. The monolith mounts
# certs/extension-server-key.pem + certs/extension-server.pem
# (server/docker-compose.yml) — `make certs` must produce exactly those
# names (the old extension-client-* naming drifted from what is mounted).
#
# !!! The HOST PKI on production is AUTHORITATIVE (spike finding b): the live
# certs on 185.213.25.5 were generated with 10-year validity (expire Jun 2036)
# and DIFFER from anything generated here. NEVER copy locally generated
# certs to prod — that would break every service's mTLS identity at once.
# This target exists for local dev/testing only.
certs:
	@mkdir -p certs
	@echo "Generating CA..."
	openssl genpkey -algorithm RSA -out certs/ca-key.pem -pkeyopt rsa_keygen_bits:4096
	openssl req -new -x509 -key certs/ca-key.pem -out certs/ca.pem -days 3650 \
		-subj "/CN=PagePocket Internal CA"
	@for svc in auth-service archive-service library-service search-service share-service api-gateway; do \
		echo "Generating cert for $$svc..."; \
		openssl genpkey -algorithm RSA -out certs/$$svc-key.pem -pkeyopt rsa_keygen_bits:2048; \
		openssl req -new -key certs/$$svc-key.pem -out certs/$$svc.csr \
			-subj "/CN=$$svc"; \
		openssl x509 -req -in certs/$$svc.csr -CA certs/ca.pem -CAkey certs/ca-key.pem \
			-CAcreateserial -out certs/$$svc.pem -days 365; \
		rm certs/$$svc.csr; \
	done
	@echo "Generating monolith mTLS client cert (canonical: extension-server)"
	@echo "  -> mounted by server/docker-compose.yml as ARCHIVE/AUTH_CLIENT_KEY/CERT"
	openssl genpkey -algorithm RSA -out certs/extension-server-key.pem -pkeyopt rsa_keygen_bits:2048
	openssl req -new -key certs/extension-server-key.pem -out certs/extension-server.csr \
		-subj "/CN=extension-server"
	openssl x509 -req -in certs/extension-server.csr -CA certs/ca.pem -CAkey certs/ca-key.pem \
		-CAcreateserial -out certs/extension-server.pem -days 365
	rm certs/extension-server.csr
	@echo "Certificates generated in certs/ (local dev only — host PKI is authoritative in prod)"
