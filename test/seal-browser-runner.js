/*
 * Seal CI driver: runs the jQuery QUnit suite (test/index.html) in headless
 * Chrome via puppeteer-core and reports per-test results on stdout.
 *
 * Usage: node test/seal-browser-runner.js <url>
 *   CHROME_PATH      Chrome/Chromium executable (required)
 *   SEAL_SKIP_TESTS  optional "|"-separated list of exact "module: test" names
 *                    (append " [N]" to target only the N-th test registered
 *                    under a duplicated name); those tests are never
 *                    registered (printed as SKIPPED)
 *
 * puppeteer-core is resolved via NODE_PATH (installed outside this tree).
 * Exit: 0 all green, 1 failures, 2 timeout / suite never finished / error.
 */
/* global process: false */
( function() {
"use strict";

var puppeteer = require( "puppeteer-core" );

var OVERALL_TIMEOUT_MS = 25 * 60 * 1000,
	HEARTBEAT_MS = 120 * 1000,
	TEST_TIMEOUT_MS = 120 * 1000,
	PREFIX = "__SEAL__",
	targetUrl = process.argv[ 2 ],
	chromePath = process.env.CHROME_PATH,
	skipList = [],
	rawSkips = ( process.env.SEAL_SKIP_TESTS || "" ).split( "|" ),
	k, s;

for ( k = 0; k < rawSkips.length; k++ ) {
	s = rawSkips[ k ].replace( /^\s+|\s+$/g, "" );
	if ( s.length ) {
		skipList.push( s );
	}
}

if ( !targetUrl ) {
	console.error( "usage: node test/seal-browser-runner.js <url>" );
	process.exit( 2 );
}
if ( !chromePath ) {
	console.error( "CHROME_PATH is not set" );
	process.exit( 2 );
}

/*
 * Serialized by puppeteer and evaluated in every frame before any page
 * script. Only the top frame is hooked: the suite spawns many iframes that
 * reach QUnit too.
 */
function pageHook( skipNames, testTimeout ) {

	// Snapshot natives up front: tests may replace window.JSON / console, and
	// a throwing reporter wedges the whole suite.
	var nativeJSON = window.JSON,
		nativeStringify = nativeJSON.stringify,
		nativeConsole = window.console,
		nativeLog = nativeConsole.log,
		skip = {},
		hooked = false,
		qunitRef, i;

	if ( window.top !== window ) {
		return;
	}

	for ( i = 0; i < skipNames.length; i++ ) {
		skip[ skipNames[ i ] ] = true;
	}

	function emit( type, data ) {
		try {
			nativeLog.call( nativeConsole, "__SEAL__" +
				nativeStringify.call( nativeJSON, { type: type, data: data } ) );
		} catch ( e ) {
			try {
				nativeLog.call( nativeConsole, "__SEAL__" + nativeStringify.call( nativeJSON, {
					type: type,
					data: { error: "unserializable payload: " + e }
				} ) );
			} catch ( e2 ) {}
		}
	}

	function dump( value ) {
		var out;
		try {
			if ( qunitRef && qunitRef.dump && qunitRef.dump.parse ) {
				out = qunitRef.dump.parse( value );
			} else {
				out = String( value );
			}
		} catch ( e ) {
			try {
				out = String( value );
			} catch ( e2 ) {
				out = "<undumpable>";
			}
		}
		if ( typeof out === "string" && out.length > 2000 ) {
			out = out.slice( 0, 2000 ) + "...";
		}
		return out;
	}

	function guard( fn ) {
		return function( d ) {
			try {
				fn( d || {} );
			} catch ( e ) {
				emit( "reporterError", { message: String( e ) } );
			}
		};
	}

	function hookQUnit( qu ) {
		var origTest, wrappedTest,
			seen = {};

		if ( hooked || !qu || !qu.config ) {
			return;
		}
		hooked = true;

		// Skip support: window.test, asyncTest (-> QUnit.test via closure),
		// and testinit.js helpers (ajaxTest, testIframe*) all end in QUnit.test,
		// where the current module is known. "module: name" skips every test
		// of that name; "module: name [N]" skips only its N-th registration
		// (some modules register two tests under the same name).
		origTest = qu.test;
		wrappedTest = function( testName ) {
			var mod = qu.config.currentModule,
				modName = mod && typeof mod === "object" ? mod.name : mod,
				key = ( modName ? modName + ": " : "" ) + testName,
				nth;
			seen[ key ] = ( seen[ key ] || 0 ) + 1;
			nth = key + " [" + seen[ key ] + "]";
			if ( skip[ key ] || skip[ nth ] ) {
				emit( "skip", { name: skip[ key ] ? key : nth } );
				return;
			}
			return origTest.apply( this, arguments );
		};
		qu.test = wrappedTest;
		window.test = wrappedTest;

		qu.config.reorder = false;
		qu.config.testTimeout = testTimeout;

		qu.begin( guard( function() {
			emit( "begin", {} );
		} ) );
		qu.moduleStart( guard( function( d ) {
			emit( "moduleStart", { name: d.name } );
		} ) );
		qu.testStart( guard( function( d ) {

			// test/data/testrunner.js resets testTimeout after QUnit loads;
			// re-apply before every test (stop() reads it).
			qu.config.testTimeout = testTimeout;
			emit( "testStart", { name: d.name, module: d.module } );
		} ) );
		qu.log( guard( function( d ) {
			if ( d.result ) {
				return;
			}
			emit( "log", {
				module: d.module,
				name: d.name,
				message: d.message === undefined ? "" : String( d.message ),
				actual: dump( d.actual ),
				expected: dump( d.expected ),
				source: d.source === undefined ? "" : String( d.source )
			} );
		} ) );
		qu.testDone( guard( function( d ) {
			emit( "testDone", {
				name: d.name,
				module: d.module,
				failed: d.failed,
				passed: d.passed,
				total: d.total
			} );
		} ) );
		qu.done( guard( function( d ) {
			emit( "done", {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} ) );
	}

	// QUnit 1.17.1 assigns window.QUnit last, after config, the logging
	// callbacks and the window.test export are in place.
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunitRef;
		},
		set: function( v ) {
			qunitRef = v;
			hookQUnit( v );
		}
	} );
}

function pad( str, n ) {
	str = String( str );
	while ( str.length < n ) {
		str += " ";
	}
	return str;
}

function main() {
	var browser, page, heartbeatTimer, overallTimer,
		finished = false,
		done = null,
		modules = {},
		moduleOrder = [],
		failedTests = 0,
		passedTests = 0,
		skippedTests = [],
		currentTest = null,
		lastProgress = Date.now(),
		lastHeartbeat = Date.now();

	function moduleStats( name ) {
		if ( !modules[ name ] ) {
			modules[ name ] = { tests: 0, failedTests: 0, assertions: 0, failedAssertions: 0 };
			moduleOrder.push( name );
		}
		return modules[ name ];
	}

	function printSummary() {
		var i, m, assertions = 0, failedAssertions = 0,
			totalTests = passedTests + failedTests;

		console.log( "" );
		console.log( "==================== SUMMARY ====================" );
		if ( skippedTests.length ) {
			console.log( "Skipped (not registered): " + skippedTests.length );
			for ( i = 0; i < skippedTests.length; i++ ) {
				console.log( "  SKIPPED: " + skippedTests[ i ] );
			}
		}
		console.log( pad( "module", 28 ) + pad( "tests", 8 ) + pad( "failed", 8 ) +
			pad( "assertions", 12 ) + "failed" );
		for ( i = 0; i < moduleOrder.length; i++ ) {
			m = modules[ moduleOrder[ i ] ];
			assertions += m.assertions;
			failedAssertions += m.failedAssertions;
			console.log( pad( moduleOrder[ i ], 28 ) + pad( m.tests, 8 ) + pad( m.failedTests, 8 ) +
				pad( m.assertions, 12 ) + m.failedAssertions );
		}
		if ( done ) {
			assertions = done.total;
			failedAssertions = done.failed;
			console.log( "QUnit done: " + done.passed + " passed, " + done.failed + " failed, " +
				done.total + " assertions; runtime " + done.runtime + " ms" );
		} else {
			console.log( "QUnit done NEVER fired" );
		}
		console.log( "Tests completed: " + totalTests + " tests, " + assertions + " assertions, " +
			failedTests + " failed, " + skippedTests.length + " skipped" );
		console.log( "SEAL QUNIT SUMMARY: total=" + totalTests + " passed=" + passedTests +
			" failed=" + failedTests + " skipped=" + skippedTests.length +
			" assertions=" + assertions + " failed_assertions=" + failedAssertions +
			" completed=" + ( done ? "true" : "false" ) );
	}

	function finish( code, reason ) {
		var closing;
		if ( finished ) {
			return;
		}
		finished = true;
		clearInterval( heartbeatTimer );
		clearTimeout( overallTimer );
		if ( reason ) {
			console.log( reason );
		}
		printSummary();
		console.log( "exit code " + code );

		// Do not let a hung browser.close() keep us alive.
		setTimeout( function() {
			process.exit( code );
		}, 15000 ).unref();
		closing = browser ? browser.close() : Promise.resolve();
		closing[ "catch" ]( function() {} ).then( function() {
			process.exit( code );
		} );
	}

	function onEvent( ev ) {
		var m,
			d = ev.data || {};

		switch ( ev.type ) {
		case "begin":
			console.log( "QUnit begin" );
			break;
		case "moduleStart":
			console.log( "MODULE " + d.name );
			break;
		case "testStart":
			currentTest = ( d.module ? d.module + ": " : "" ) + d.name;
			break;
		case "log":
			console.log( "    assertion failed: " + d.message );
			console.log( "      expected: " + d.expected );
			console.log( "      actual:   " + d.actual );
			if ( d.source ) {
				console.log( "      source:   " +
					String( d.source ).split( "\n" ).join( "\n                " ) );
			}
			break;
		case "testDone":
			lastProgress = Date.now();
			lastHeartbeat = lastProgress;
			currentTest = null;
			m = moduleStats( d.module || "(no module)" );
			m.tests++;
			m.assertions += d.total;
			m.failedAssertions += d.failed;
			if ( d.failed > 0 ) {
				m.failedTests++;
				failedTests++;
			} else {
				passedTests++;
			}
			console.log( ( d.failed > 0 ? "FAIL " : "ok   " ) + d.module + ": " + d.name +
				" (" + d.passed + "/" + d.total + ")" );
			break;
		case "skip":
			skippedTests.push( d.name );
			console.log( "SKIPPED: " + d.name );
			break;
		case "reporterError":
			console.log( "REPORTER ERROR: " + d.message );
			break;
		case "done":
			done = d;
			finish( d.failed === 0 && failedTests === 0 ? 0 : 1 );
			break;
		default:
			console.log( "unknown event type: " + ev.type );
		}
	}

	overallTimer = setTimeout( function() {
		finish( 2, "TIMEOUT: suite did not finish within " + ( OVERALL_TIMEOUT_MS / 60000 ) +
			" minutes" + ( currentTest ? " (running: " + currentTest + ")" : "" ) );
	}, OVERALL_TIMEOUT_MS );

	heartbeatTimer = setInterval( function() {
		var now = Date.now();
		if ( now - lastHeartbeat >= HEARTBEAT_MS ) {
			lastHeartbeat = now;
			console.log( "HEARTBEAT: no test completed in " +
				Math.round( ( now - lastProgress ) / 1000 ) + "s; running: " +
				( currentTest || "(none / between tests)" ) );
		}
	}, 5000 );

	console.log( "URL: " + targetUrl );
	console.log( "Chrome: " + chromePath );
	console.log( "SEAL_SKIP_TESTS: " + skipList.length + " test(s)" );

	puppeteer.launch( {
		executablePath: chromePath,
		headless: true,
		args: [ "--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1" ]
	} ).then( function( b ) {
		browser = b;
		browser.on( "disconnected", function() {
			finish( 2, "ERROR: browser disconnected before QUnit done" );
		} );
		return browser.version();
	} ).then( function( version ) {
		console.log( "Browser: " + version );
		return browser.newPage();
	} ).then( function( p ) {
		page = p;
		page.on( "console", function( msg ) {
			var ev,
				text = msg.text();
			if ( text.indexOf( PREFIX ) !== 0 ) {
				return;
			}
			try {
				ev = JSON.parse( text.slice( PREFIX.length ) );
			} catch ( e ) {
				console.log( "unparseable reporter line: " + text.slice( 0, 500 ) );
				return;
			}
			onEvent( ev );
		} );
		page.on( "pageerror", function( err ) {
			console.log( "PAGE ERROR: " + ( err && err.message ? err.message : String( err ) ) );
		} );
		page.on( "dialog", function( dialog ) {
			console.log( "DIALOG (" + dialog.type() + "): " + dialog.message() );
			dialog.dismiss()[ "catch" ]( function() {} );
		} );
		page.on( "error", function( err ) {
			finish( 2, "ERROR: page crashed: " + ( err && err.message ? err.message : String( err ) ) );
		} );
		return page.evaluateOnNewDocument( pageHook, skipList, TEST_TIMEOUT_MS );
	} ).then( function() {
		return page[ "goto" ]( targetUrl, { waitUntil: "domcontentloaded", timeout: 120000 } );
	} ).then( function() {
		console.log( "page loaded; waiting for QUnit done" );
	} )[ "catch" ]( function( err ) {
		finish( 2, "ERROR: " + ( err && err.stack ? err.stack : String( err ) ) );
	} );
}

main();

} )();
