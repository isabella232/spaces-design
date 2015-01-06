/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

define(function (require, exports) {
    "use strict";

    var Promise = require("bluebird"),
        Immutable = require("immutable"),
        _ = require("lodash");
        
    var descriptor = require("adapter/ps/descriptor"),
        documentLib = require("adapter/lib/document"),
        layerLib = require("adapter/lib/layer"),
        contentLib = require("adapter/lib/contentLayer"),
        unitLib = require("adapter/lib/unit");

    var events = require("../events"),
        locks = require("js/locks"),
        log = require("js/util/log"),
        layerActions = require("./layers"),
        collection = require("js/util/collection");

    /**
     * Helper function to determine if any layers being transformed are groups
     * @param {Array.<Layer>} layerSpec Layers being transformed
     * @return {boolean} True if any of the layers are a group
     */
    var _transformingAnyGroups = function (layerSpec) {
        return layerSpec.some(function (layer) {
            return layer.kind === layer.layerKinds.GROUP;
        });
    };
    
    /**
     * Helper function for setPosition action, prepares the playobject
     * @private
     * @param {Document} document
     * @param {Layer} layer
     * @param {{x: number, y: number}} position
     * @return {PlayObject}
     */
    var _getTranslatePlayObject = function (document, layer, position) {
        var childBounds = document.layers.childBounds(layer),
            documentRef = documentLib.referenceBy.id(document.id),
            layerRef = [documentRef, layerLib.referenceBy.id(layer.id)],
            newX = position.hasOwnProperty("x") ? position.x : childBounds.left,
            newY = position.hasOwnProperty("y") ? position.y : childBounds.top,
            xDelta = unitLib.pixels(newX - childBounds.left),
            yDelta = unitLib.pixels(newY - childBounds.top),
            translateObj = layerLib.translate(layerRef, xDelta, yDelta);

        return translateObj;
    };

    /**
     * Sets the given layers' positions
     * @private
     * @param {Document} document Owner document
     * @param {Layer|Array.<Layer>} layerSpec Either a Layer reference or array of Layers
     * @param {{x: number, y: number}} position New top and left values for each layer
     *
     * @return {Promise}
     */
    var setPositionCommand = function (document, layerSpec, position) {
        layerSpec = layerSpec.filterNot(function (layer) {
            return layer.kind === layer.layerKinds.GROUPEND;
        });

        var layerIDs = collection.pluck(layerSpec, "id"),
            payload = {
                documentID: document.id,
                layerIDs: layerIDs,
                position: position
            };

        this.dispatch(events.document.TRANSLATE_LAYERS, payload);

        if (layerSpec.size === 1) {
            var layer = layerSpec.first(),
                translateObj = _getTranslatePlayObject.call(this, document, layer, position);
                
            return descriptor.playObject(translateObj)
                .bind(this)
                .then(function () {
                    if (_transformingAnyGroups(layerSpec)) {
                        var descendants = document.layers.descendants(layer);

                        return this.transfer(layerActions.resetLayers, document, descendants);
                    }
                });
        } else {
            // Photoshop does not apply "transform" objects to the referenced layer, and instead 
            // applies it to all selected layers, so here we deselectAll, 
            // and in chunks select one and move it and reselect all layers.
            // This is a temporary work around until we fix the underlying issue on PS side
            var documentRef = documentLib.referenceBy.id(document.id),
                playObjects = layerSpec.reduce(function (playObjects, layer) {
                    var layerRef = layerLib.referenceBy.id(layer.id),
                        selectObj = layerLib.select([documentRef, layerRef]),
                        translateObj = _getTranslatePlayObject.call(this, document, layer, position);
                    
                    playObjects.push(selectObj);
                    playObjects.push(translateObj);
                    return playObjects;
                }, []);

            var allLayerRefs = layerSpec.map(function (layer) {
                return layerLib.referenceBy.id(layer.id);
            });
            allLayerRefs = allLayerRefs.unshift(documentRef);

            var selectAllObj = layerLib.select(allLayerRefs.toArray());
            playObjects.push(selectAllObj);
            
            return descriptor.batchPlayObjects(playObjects)
                .bind(this)
                .then(function () {
                    if (_transformingAnyGroups(layerSpec)) {
                        var descendants = layerSpec.flatMap(document.layers.descendants, document.layers)
                            .toSet();

                        return this.transfer(layerActions.resetLayers, document, descendants);
                    }
                });
        }
    };

    /**
     * For two layers, calculates a new top left for both, keeping them within
     * the same bounding box, but swapping their locations
     *
     *  - If the two layers' top, bottom or vertical centers are close to each other
     *      We do intelligent swapping horizontally, but keep the layers in the same vertical location
     *      These cases usually apply to things like: Number and the numbered list item
     *      
     *  - If left, horizontal center, or right edges are close to each other
     *      We swap just the tops, keeping the layers in same horizontal location
     *      This applies to cases like two items in a list
     *      
     *  - Otherwise, we swap the layers top/left corners with each other. This applies to all other general cases
     *
     * @private
     * @param {Document} document
     * @param {Immutable.Iterable.<Layer>} layers
     * @param {number} sensitivity Fraction of the edge difference to consider two layers on same axis
     * @return {Immutable.List.<{x: number, y: number}>} New position objects for layers
     */
    var _calculateSwapLocations = function (document, layers, sensitivity) {
        sensitivity = sensitivity || 10;
        
        var l1 = document.layers.childBounds(layers.get(0)),
            l2 = document.layers.childBounds(layers.get(1)),
            boundingBox = {
                left: Math.min(l1.left, l2.left),
                right: Math.max(l1.right, l2.right),
                top: Math.min(l1.top, l2.top),
                bottom: Math.max(l1.bottom, l2.bottom)
            },
            l1VertCenter = l1.top + l1.height / 2,
            l2VertCenter = l2.top + l2.height / 2,
            l1HorzCenter = l1.left + l1.width / 2,
            l2HorzCenter = l2.left + l2.width / 2,
            heightFraction = (boundingBox.bottom - boundingBox.top) / sensitivity,
            widthFraction = (boundingBox.right - boundingBox.left) / sensitivity,
            verticalEdgeClose = Math.abs(l1.left - l2.left) < widthFraction ||
                Math.abs(l1.right - l2.right) < widthFraction ||
                Math.abs(l1HorzCenter - l2HorzCenter) < widthFraction,
            horizontalEdgeClose = Math.abs(l1.top - l2.top) < heightFraction ||
                Math.abs(l1.bottom - l2.bottom) < heightFraction ||
                Math.abs(l1VertCenter - l2VertCenter) < heightFraction,
            l1Left = null,
            l1Top = null,
            l2Left = null,
            l2Top = null;

        if (verticalEdgeClose) {
            l1Left = l1.left;
            l1Top = l2.top;
            l2Left = l2.left;
            l2Top = l1.top;
        } else if (horizontalEdgeClose) {
            l1Left = boundingBox.left + boundingBox.right - l1.right;
            l2Left = boundingBox.left + boundingBox.right - l2.right;
            l1Top = l1.top;
            l2Top = l2.top;
        } else {
            l1Left = l2.left;
            l1Top = l2.top;
            l2Left = l1.left;
            l2Top = l1.top;
        }
        
        return Immutable.List.of(
            {x: l1Left, y: l1Top},
            {x: l2Left, y: l2Top}
        );
    };

    /**
     * Swaps the two given layers top-left positions
     *
     * @private
     * @param {Document} document Owner document
     * @param {[<Layer>, <Layer>]} layers An array of two layers
     *
     * @return {Promise}
     */
    var swapLayersCommand = function (document, layers) {
        // validate layers input
        if (layers.size !== 2) {
            throw new Error("Expected two layers");
        }

        // Don't act if one of the layers is an empty bound
        if (layers.every(function (layer) { return layer.kind === layer.layerKinds.GROUPEND; })) {
            return Promise.resolve();
        }

        var newPositions = _calculateSwapLocations(document, layers),
            documentRef = documentLib.referenceBy.id(document.id),
            translateObjects = [
                _getTranslatePlayObject.call(this, document, layers.get(0), newPositions.get(0)),
                _getTranslatePlayObject.call(this, document, layers.get(1), newPositions.get(1))
            ],
            payloadOne = {
                documentID: document.id,
                layerIDs: [layers.get(0).id],
                position: newPositions.get(0)
            },
            payloadTwo = {
                documentID: document.id,
                layerIDs: [layers.get(1).id],
                position: newPositions.get(1)
            };


        this.dispatch(events.document.TRANSLATE_LAYERS, payloadOne);
        this.dispatch(events.document.TRANSLATE_LAYERS, payloadTwo);

        // Photoshop does not apply "transform" objects to the referenced layer,
        // so here we select each layer individually and move it, then reselect all
        // layers. This is a temporary work around until we fix the underlying issue
        // on PS side
        var playObjects = layers.reduce(function (playObjects, layer, index) {
            var layerRef = layerLib.referenceBy.id(layer.id),
                selectObj = layerLib.select([documentRef, layerRef]),
                translateObj = translateObjects[index];

            playObjects.push(selectObj);
            playObjects.push(translateObj);

            return playObjects;
        }, []);

        var layerRef = layers.map(function (layer) {
            return layerLib.referenceBy.id(layer.id);
        });
        layerRef = layerRef.unshift(documentRef);

        playObjects.push(layerLib.select(layerRef.toArray()));

        var batchOptions = {
            historyStateInfo: {
                name: "swap-layers",
                target: documentRef
            }
        };
        return descriptor.batchPlayObjects(playObjects, undefined, batchOptions)
            .bind(this)
            .then(function () {
                if (_transformingAnyGroups(layers)) {
                    var descendants = layers.flatMap(document.layers.descendants, document.layers)
                        .toSet();

                    return this.transfer(layerActions.resetLayers, document, descendants);
                }
            });
    };

    /**
     * Sets the bounds of currently selected layer group in the given document
     *
     * @param {Document} document Target document to run action in
     * @param {Bounds} oldBounds The original bounding box of selected layers
     * @param {Bounds} newBounds Bounds to transform to
     */
    var setBoundsCommand = function (document, oldBounds, newBounds) {
        var documentRef = documentLib.referenceBy.id(document.id),
            widthDiff = newBounds.width - oldBounds.width,
            heightDiff = newBounds.height - oldBounds.height,
            xDelta = unitLib.pixels(newBounds.left - oldBounds.left + widthDiff / 2),
            yDelta = unitLib.pixels(newBounds.top - oldBounds.top + heightDiff / 2),
            pixelWidth = unitLib.pixels(newBounds.width),
            pixelHeight = unitLib.pixels(newBounds.height),
            layerRef = [documentRef, layerLib.referenceBy.current],
            translateObj = layerLib.translate(layerRef, xDelta, yDelta),
            resizeObj = layerLib.setSize(layerRef, pixelWidth, pixelHeight),
            resizeAndMoveObj = _.merge(translateObj, resizeObj);

        return descriptor.playObject(resizeAndMoveObj)
            .bind(this)
            .then(function () {
                var selected = document.layers.selected,
                    descendants = selected.flatMap(document.layers.descendants, document.layers)
                    .toSet();

                return this.transfer(layerActions.resetLayers, document, descendants);
            });
    };

    /**
     * Helper function for resize action, calculates the new x/y values for a layer
     * when it's resized so the layer is resized from top left
     * @private
     * @param {Document} document
     * @param {Layer} layer
     * @param {{w: number, h: number}} size
     * @return {PlayObject}
     */
    var _getResizePlayObject = function (document, layer, size) {
        var childBounds = document.layers.childBounds(layer),
            documentRef = documentLib.referenceBy.id(document.id),
            newWidth = size.hasOwnProperty("w") ? size.w : childBounds.width,
            newHeight = size.hasOwnProperty("h") ? size.h : childBounds.height,
            widthDiff = newWidth - childBounds.width,
            heightDiff = newHeight - childBounds.height,
            pixelWidth = unitLib.pixels(newWidth),
            pixelHeight = unitLib.pixels(newHeight),
            xDelta = unitLib.pixels(widthDiff / 2),
            yDelta = unitLib.pixels(heightDiff / 2),
            layerRef = [documentRef, layerLib.referenceBy.id(layer.id)],
            translateObj = layerLib.translate(layerRef, xDelta, yDelta),
            resizeObj = layerLib.setSize(layerRef, pixelWidth, pixelHeight),
            resizeAndMoveObj = _.merge(translateObj, resizeObj);

        return resizeAndMoveObj;
    };

    /**
     * Sets the given layers' sizes
     * @private
     * @param {Document} document Owner document
     * @param {Layer|Array.<Layer>} layerSpec Either a Layer reference or array of Layers
     * @param {w: {number}, h: {number}} size New width and height of the layers
     *
     * @returns {Promise}
     */
    var setSizeCommand = function (document, layerSpec, size) {
        layerSpec = layerSpec.filterNot(function (layer) {
            return layer.kind === layer.layerKinds.GROUPEND;
        });

        var layerIDs = collection.pluck(layerSpec, "id"),
            payload = {
                documentID: document.id,
                layerIDs: layerIDs,
                size: size
            };

        // Document
        if (layerSpec.size === 0) {
            this.dispatch(events.document.RESIZE_DOCUMENT, payload);

            var newWidth = size.hasOwnProperty("w") ? size.w : document.bounds.width,
                unitsWidth = unitLib.pixels(newWidth),
                newHeight = size.hasOwnProperty("h") ? size.h : document.bounds.height,
                unitsHeight = unitLib.pixels(newHeight),
                resizeObj = documentLib.resize(unitsWidth, unitsHeight);

            return descriptor.playObject(resizeObj);
        } else {
            this.dispatch(events.document.RESIZE_LAYERS, payload);

            if (layerSpec.size === 1) {
                var layer = layerSpec.first();
                // We have this in a map function because setSize anchors center
                // We calculate the new translation values to keep the layer anchored on top left
                var resizeAndMoveObj = _getResizePlayObject.call(this, document, layer, size);

                return descriptor.playObject(resizeAndMoveObj)
                    .bind(this)
                    .then(function () {
                        if (_transformingAnyGroups(layerSpec)) {
                            var descendants = document.layers.descendants(layer);

                            return this.transfer(layerActions.resetLayers, document, descendants);
                        }
                    });
            } else {
                // We need to do this now, otherwise store gets updated before we can read current values
                var documentRef = documentLib.referenceBy.id(document.id),
                    playObjects = layerSpec.reduce(function (playObjects, layer) {
                        var layerRef = layerLib.referenceBy.id(layer.id),
                            selectObj = layerLib.select([documentRef, layerRef]),
                            resizeAndMoveObj = _getResizePlayObject.call(this, document, layer, size);

                        playObjects.push(selectObj);
                        playObjects.push(resizeAndMoveObj);
                        return playObjects;
                    }, []);

                var allLayerRefs = layerSpec.map(function (layer) {
                    return layerLib.referenceBy.id(layer.id);
                });
                allLayerRefs = allLayerRefs.unshift(documentRef);

                var selectAllObj = layerLib.select(allLayerRefs.toArray());
                playObjects.push(selectAllObj);

                return descriptor.batchPlayObjects(playObjects)
                    .bind(this)
                    .then(function () {
                        if (_transformingAnyGroups(layerSpec)) {
                            var descendants = layerSpec.flatMap(document.layers.descendants, document.layers)
                                .toSet();

                            return this.transfer(layerActions.resetLayers, document, descendants);
                        }
                    });
            }
        }
    };
    
    /**
     * Asks photoshop to flip, either horizontally or vertically.
     * Note: this expects an array of layer models, but it only passes the first layer ref to the adapter
     * which seems to expect a ref to at least one active layer.
     * @private
     * @param {Document} document document model object
     * @param {Array.<Layer>} layers array of layer models
     * @param {string} axis Either horizontal or vertical
     *
     * @return {Promise}
     */
    var flipCommand = function (document, layers, axis) {
        // validate layers input
        if (layers.size < 1) {
            throw new Error("Expected at least one layer");
        }
        
        // Get a representative layer (non background)
        // This is a workaround.  The flip action validates that an active, non-background layer ref
        // is provided, even though this is ignored by the underlying photoshop flip process
        var repLayer = layers.find(function (l) { return !l.isBackground; });
        if (!repLayer) {
            throw new Error("flip was not provided a valid non-background layer");
        }
        
        // build a ref, and call photoshop
        var ref = layerLib.referenceBy.id(repLayer.id),
            flipPromise = descriptor.playObject(layerLib.flip(ref, axis));
        
        // TODO the following is not needed yet, because nothing cares about this event
        /**
        var payload = {
            documentID: document.id,
            layerIDs: collection.pluck(layers, "id"),
            axis: axis
        };
        this.dispatch(events.document.FLIP_LAYERS, payload);
        */
        
        return flipPromise
            .bind(this)
            .then(function () {
                // TODO there are more targeting ways of updating the bounds for the affected layers
                var descendants = layers.flatMap(document.layers.descendants, document.layers)
                    .toSet();

                return this.transfer(layerActions.resetLayers, document, descendants);
            });
    };
    
    /**
     * Helper command to flip horizontally
     * @private
     *
     * @param {Document} document document model object
     * @param {Array.<Layer>} layers array of layer models 
     * @return {Promise}
     */
    var flipXCommand = function (document, layers) {
        return flipCommand.call(this, document, layers, "horizontal");
    };
    
    /**
     * Helper command to flip vertically
     *
     * @private
     * @param {Document} document document model object
     * @param {Array.<Layer>} layers array of layer models 
     * @return {Promise}
     */
    var flipYCommand = function (document, layers) {
        return flipCommand.call(this, document, layers, "vertical");
    };

    /**
     * Helper command to flip selected layers in the current document horizontally
     *
     * @private
     * @return {Promise}
     */
    var flipXCurrentDocumentCommand = function () {
        var applicationStore = this.flux.store("application"),
            currentDocument = applicationStore.getCurrentDocument(),
            selectedLayers = currentDocument.layers.selected;

        if (!currentDocument || currentDocument.layers.selectedLocked) {
            return Promise.resolve();
        }
        
        return this.transfer(flipX, currentDocument, selectedLayers);
    };
    
    /**
     * Helper command to flip selected layers in the current document vertically
     *
     * @private
     * @return {Promise}
     */
    var flipYCurrentDocumentCommand = function () {
        var applicationStore = this.flux.store("application"),
            currentDocument = applicationStore.getCurrentDocument(),
            selectedLayers = currentDocument.layers.selected;

        if (!currentDocument || currentDocument.layers.selectedLocked) {
            return Promise.resolve();
        }

        return this.transfer(flipY, currentDocument, selectedLayers);
    };

    /**
     * Set the radius of the rectangle shapes in the given layers of the given
     * document to the given number of pixels. Currently, the command ignores
     * document and layers paramters and acts on the selected layers of the
     * active document.
     * 
     * @param {Document} document
     * @param {Array.<Layer>} layers
     * @param {number} radius New uniform border radius in pixels
     */
    var setRadiusCommand = function (document, layers, radius) {
        var radiusDescriptor = contentLib.setRadius(radius);

        this.dispatch(events.document.RADII_CHANGED, {
            documentID: document.id,
            layerIDs: collection.pluck(layers, "id"),
            radii: {
                topLeft: radius,
                topRight: radius,
                bottomRight: radius,
                bottomLeft: radius
            }
        });

        return descriptor.playObject(radiusDescriptor);
    };

    /**
     * Helper command to swap the two given layers top-left positions
     *
     * @private
     *
     * @return {Promise}
     */
    var swapLayersCurrentDocumentCommand = function () {
        var applicationStore = this.flux.store("application"),
            currentDocument = applicationStore.getCurrentDocument(),
            selectedLayers = currentDocument.layers.selected;

        if (!currentDocument ||
            currentDocument.layers.selectedLocked ||
            selectedLayers.length !== 2) {
            return Promise.resolve();
        }
        return this.transfer(swapLayers, currentDocument, selectedLayers);
    };

    /**
     * Rotates the currently selected layers by given angle
     *
     * @param {Document} document 
     * @param {number} angle Angle in degrees
     * @return {Promise}
     */
    var rotateCommand = function (document, angle) {
        var documentRef = documentLib.referenceBy.id(document.id),
            layerRef = [documentRef, layerLib.referenceBy.current],
            rotateObj = layerLib.rotate(layerRef, angle);

        return descriptor.playObject(rotateObj)
            .bind(this)
            .then(function () {
                var selected = document.layers.selected,
                    descendants = selected.flatMap(document.layers.descendants, document.layers)
                    .toSet();

                return this.transfer(layerActions.resetLayers, document, descendants);
            });
    };

    /**
     * Helper command to rotate layers in currently selected document through the menu
     *
     * @param  {{angle: number}} payload Contains the angle to rotate layers by
     * @return {Promise}
     */
    var rotateLayersInCurrentDocumentCommand = function (payload) {
        if (!payload.hasOwnProperty("angle")) {
            log.error("Missing angle");
            return Promise.resolve();
        }

        var applicationStore = this.flux.store("application"),
            currentDocument = applicationStore.getCurrentDocument();

        if (!currentDocument ||
            currentDocument.layers.selectedLocked) {
            return Promise.resolve();
        }

        var angle = payload.angle;

        return this.transfer(rotate, currentDocument, angle);
    };

    /**
     * Action to set Position
     * @type {Action}
     */
    var setPosition = {
        command: setPositionCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to set Size
     * @type {Action}
     */
    var setSize = {
        command: setSizeCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to set Size
     * @type {Action}
     */
    var setBounds = {
        command: setBoundsCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to flip horizontally
     * @type {Action}
     */
    var flipX =  {
        command: flipXCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to flip vertically
     * @type {Action}
     */
    var flipY = {
        command: flipYCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };
    
    /**
     * Action to flip the current document's selected layers horizontally
     * @type {Action}
     */
    var flipXCurrentDocument =  {
        command: flipXCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to flip the current document's selected layers vertically
     * @type {Action}
     */
    var flipYCurrentDocument = {
        command: flipYCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to swap two selected layers
     * @type {Action}
     */
    var swapLayers = {
        command: swapLayersCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to swap the two selected layers top-left positions in the current document
     * @type {Action}
     */
    var swapLayersCurrentDocument = {
        command: swapLayersCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to the set the border radius of a rectangle shape layer
     * @type {Action}
     */
    var setRadius = {
        command: setRadiusCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action to set the rotation angle of current layer
     * @type {Action}
     */
    var rotate = {
        command: rotateCommand,
        reads: [locks.PS_DOC, locks.JS_DOC],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    /**
     * Action that rotates all selected layers a certain degree
     * @type {Action}
     */
    var rotateLayersInCurrentDocument = {
        command: rotateLayersInCurrentDocumentCommand,
        reads: [locks.PS_DOC, locks.JS_DOC, locks.JS_APP],
        writes: [locks.PS_DOC, locks.JS_DOC]
    };

    exports.setPosition = setPosition;
    exports.setSize = setSize;
    exports.flipX = flipX;
    exports.flipY = flipY;
    exports.flipXCurrentDocument = flipXCurrentDocument;
    exports.flipYCurrentDocument = flipYCurrentDocument;
    exports.swapLayers = swapLayers;
    exports.swapLayersCurrentDocument = swapLayersCurrentDocument;
    exports.setRadius = setRadius;
    exports.setBounds = setBounds;
    exports.rotate = rotate;
    exports.rotateLayersInCurrentDocument = rotateLayersInCurrentDocument;


});
