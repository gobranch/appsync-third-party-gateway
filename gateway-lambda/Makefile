CURRENT_DIR := $(dir $(abspath $(firstword $(MAKEFILE_LIST))))

build-GatewayLambda:
	cd $(CURRENT_DIR); \
	yarn build -so $(ARTIFACTS_DIR) 