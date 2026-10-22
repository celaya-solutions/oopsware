```text
Document:    Foundation XML archive encoding fixture
Version:     v1.0.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-13
SHA256:      6a56b09b5870cbbb24d4ff4864c9418cf3dde38b711902d7df2d1845facd37b3
Chain:       solana-mainnet
Tx:          5zWuEkpV95L79JCqpSBLwQ54V79AFf9ncRPLHJZLBUjRGJsfJ5KPb66v68NHveci5fNuo5k5xxBWwARpW1DQDon7
License:     All Rights Reserved / Celaya Solutions
```

# Foundation XML archive encoding fixture

`producer.swift` creates an actual NSKeyedArchiver XML representation, then
uses Foundation string encoding to produce BOM-marked UTF-16 little- and
big-endian representations of the same XML graph. Foundation's
PropertyListSerialization reads both representations successfully; `plutil
-lint` also accepts all three files.

```sh
xcrun swiftc producer.swift -o writer
./writer archive.xml little-endian.plist big-endian.plist
plutil -lint archive.xml little-endian.plist big-endian.plist
```

Only the UTF-8 XML source capture is committed. The tests encode its same text
as UTF-16 so no compiled binaries or binary fixtures are committed. This is
format/filesystem verification; no archived classes are instantiated by Oopsware.
