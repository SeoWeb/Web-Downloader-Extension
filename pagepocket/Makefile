.PHONY: proto build dev up down migrate test lint format certs help

PROTO_DIR := proto
STUBS_DIR := shared/proto_generated
SERVICES := auth-service archive-service library-service search-service share-service

help:
	@echo "PagePocket Backend"
	@echo ""
	@echo "  make proto      Generate gRPC stubs from .proto files"
	@echo "  make build      Build all service Docker images"
	@echo "  make dev        Start the dev stack (docker compose up)"
	@echo "  make up         Alias for dev"
	@echo "  make down       Stop the dev stack"
	@echo "  make migrate    Run Alembic migrations for all services"
	@echo "  make test       Run pytest across all services"
	@echo "  make lint       Run ruff linter"
	@echo "  make format     Run ruff + black formatter"
	@echo "  make certs      Generate mTLS CA + service certificates"

proto:
	@mkdir -p $(STUBS_DIR)
	python3 -m grpc_tools.protoc \
		-I $(PROTO_DIR) \
		--python_out=$(STUBS_DIR) \
		--grpc_python_out=$(STUBS_DIR) \
		$(PROTO_DIR)/*.proto
	@touch $(STUBS_DIR)/__init__.py
	@echo "Proto stubs generated in $(STUBS_DIR)"

build:
	docker compose build

dev: build
	docker compose up -d

up: dev

down:
	docker compose down

migrate:
	@for svc in $(SERVICES); do \
		echo "Running migrations for $$svc..."; \
		docker compose exec $$svc python -m alembic -c /app/alembic.ini upgrade head; \
	done

test:
	@for svc in $(SERVICES); do \
		echo "Testing $$svc..."; \
		cd services/$$svc && python -m pytest tests/ -v && cd ../..; \
	done

lint:
	ruff check services/ shared/ proto/

format:
	ruff check --fix services/ shared/ proto/
	black services/ shared/

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
	@echo "Generating shared client cert for extension server..."
	openssl genpkey -algorithm RSA -out certs/extension-client-key.pem -pkeyopt rsa_keygen_bits:2048
	openssl req -new -key certs/extension-client-key.pem -out certs/extension-client.csr \
		-subj "/CN=extension-server"
	openssl x509 -req -in certs/extension-client.csr -CA certs/ca.pem -CAkey certs/ca-key.pem \
		-CAcreateserial -out certs/extension-client.pem -days 365
	rm certs/extension-client.csr
	@echo "Certificates generated in certs/"
