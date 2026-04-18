dev:
	npx tsx src/index.ts

build:
	npx tsc

start:
	node dist/index.js

db-generate:
	npx prisma generate

db-migrate:
	npx prisma migrate dev

db-push:
	npx prisma db push

install:
	npm install
