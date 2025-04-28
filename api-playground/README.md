# API playground

This repo consists information of all the products and thier mock payloads to be rendered in API playground.

API references are pulled from the `api-references` folder.

`products.json` contains all the products that are available in API playground.

## Repo structure of `json` folder

-   Each category is a folder with products as sub-folders and JSON files inside product folders.
-   All files are JSON and they are named after the `operationID` of each request in API reference.
-   In every JSON file, you'll find
     - `parameters` object containing, header, query, path etc
     - `body` object which is the example body of that request
