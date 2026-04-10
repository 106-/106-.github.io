.PHONY: format serve

format:
	npx prettier --write "**/*.{html,js,css}"

serve:
	npx serve .
