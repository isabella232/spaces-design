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


define(function (require, exports, module) {
    "use strict";

    var React = require("react"),
        Fluxxor = require("fluxxor"),
        FluxMixin = Fluxxor.FluxMixin(React),
        StoreWatchMixin = Fluxxor.StoreWatchMixin,
        _ = require("lodash"),
        Immutable = require("immutable");

    var Gutter = require("jsx!js/jsx/shared/Gutter"),
        Label = require("jsx!js/jsx/shared/Label"),
        Button = require("jsx!js/jsx/shared/Button"),
        SVGIcon = require("jsx!js/jsx/shared/SVGIcon"),
        Datalist = require("jsx!js/jsx/shared/Datalist"),
        TextInput = require("jsx!js/jsx/shared/TextInput");

    var collection = require("js/util/collection");


    var scaleOptions = Immutable.OrderedMap({
        "0.5": {
            id: "0.5",
            title: "0.5x"
        },
        "1": {
            id: "1",
            title: "1x"
        },
        "1.5": {
            id: "1.5",
            title: "1.5x"
        },
        "2": {
            id: "2",
            title: "2x"
        }
    });

    var formatOptions = Immutable.OrderedMap({
        "png": {
            id: "png",
            title: "PNG"
        },
        "jpg": {
            id: "jpg",
            title: "JPG"
        },
        "svg": {
            id: "svg",
            title: "SVG"
        },
        "pdf": {
            id: "pdf",
            title: "PDF"
        }
    });

    var allScales = [0.5, 1, 1.5, 2];

    var LayerExportAsset = React.createClass({

        mixins: [FluxMixin],

        propTypes: {
            index: React.PropTypes.number.isRequired,
            layer: React.PropTypes.object.isRequired,
            exportAsset: React.PropTypes.object.isRequired
        },

        /**
         * Delete this asset
         *
         * @private
         * @return {Promise}
         */
        _handleDeleteClick: function () {
            var document = this.props.document,
                layer = this.props.layer,
                index = this.props.index;

            this.getFlux().actions.export.deleteLayerExportAsset(document, layer, index);
        },

        /**
         * Update this asset's scale
         *
         * @private
         * @return {Promise}
         */
        _handleUpdateScale: function (scale) {
            var scaleNum = Number.parseFloat(scale);

            this.getFlux().actions.export.updateLayerAssetScale(
                this.props.document, this.props.layer, this.props.index, scaleNum);
        },

        /**
         * Update this asset's suffix
         *
         * @private
         * @return {Promise}
         */
        _handleUpdateSuffix: function (event, suffix) {
            this.getFlux().actions.export.updateLayerAssetSuffix(
                this.props.document, this.props.layer, this.props.index, suffix);
        },

        /**
         * Update this asset's format
         *
         * @private
         * @return {Promise}
         */
        _handleUpdateFormat: function (format) {
            var formatLower = format && format.toLowerCase();

            this.getFlux().actions.export.updateLayerAssetFormat(
                this.props.document, this.props.layer, this.props.index, formatLower);
        },

        render: function () {
            var layer = this.props.layer,
                exportAsset = this.props.exportAsset,
                scale = exportAsset.scale || 1,
                scaleOption = scaleOptions.has(scale.toString()) ?
                    scaleOptions.get(scale.toString()) : scaleOptions.get("1"),
                scaleListID = "layerExportAsset-scale" + layer.id + "-" + this.props.index,
                formatListID = "layerExportAsset-format-" + layer.id + "-" + this.props.index;

            return (
                <div className="formline">
                    <Datalist
                        list={scaleListID}
                        className="dialog-export-scale"
                        options={scaleOptions.toList()}
                        value={scaleOption.title}
                        onChange={this._handleUpdateScale}
                        live={false}
                        size="column-3" />
                    <Gutter />
                    <TextInput
                        value={exportAsset.suffix}
                        singleClick={true}
                        editable={true}
                        onChange={this._handleUpdateSuffix}
                        size="column-6" />
                    <Gutter />
                    <Datalist
                        list={formatListID}
                        className="dialog-export-format"
                        options={formatOptions.toList()}
                        value={exportAsset.format.toUpperCase()}
                        onChange={this._handleUpdateFormat}
                        live={false}
                        size="column-4" />
                    <Gutter />
                    <Button
                        className="button-plus" // a bit of a hack
                        title="remove asset configuration"
                        onClick={this._handleDeleteClick}>
                        <SVGIcon
                            viewbox="0 0 12 14"
                            CSSID="libraries-delete" />
                    </Button>
                </div>
            );
        }
    });

    var LayerExports = React.createClass({

        mixins: [FluxMixin, StoreWatchMixin("export")],

        propTypes: {
            document: React.PropTypes.object.isRequired
        },

        getStateFromFlux: function () {
            var flux = this.getFlux(),
                documentID = this.props.document.id,
                documentExports = flux.store("export").getDocumentExports(documentID);

            return {
                documentExports: documentExports
            };
        },

        /**
         * Add a new Asset to this list
         *
         * @private
         * @return {Promise}
         */
        _addAssetClickHandler: function (layer) {
            var document = this.props.document,
                documentExports = this.state.documentExports,
                layerExports = documentExports && documentExports.layerExportsMap.get(layer.id);

            // Determine the scale of the potential next asset
            var remainingScales = _.difference(allScales, collection.pluck(layerExports, "scale").toArray()),
                nextScale = remainingScales.length > 0 ? remainingScales[0] : null,
                nextAssetIndex = (layerExports && layerExports.size) || 0;

            return this.getFlux().actions.export.updateLayerAssetScale(document, layer, nextAssetIndex, nextScale);
        },

        render: function () {
            var document = this.props.document,
                documentExports = this.state.documentExports;

            if (!document || document.layers.selected.size !== 1) {
                return (<div>Please select a single layer</div>);
            }

            var selectedLayer = document.layers.selected.first(),
                layerExports = documentExports && documentExports.layerExportsMap.get(selectedLayer.id);

            var exportComponents = [];
            if (layerExports && layerExports.size > 0) {
                layerExports.forEach(function (i, k) {
                    var x = (
                        <LayerExportAsset
                            document={this.props.document}
                            index={k}
                            key={k}
                            layer={selectedLayer}
                            exportAsset={i} />
                    );
                    exportComponents.push(x);
                }.bind(this));
            }

            return (
                <div>
                    <div className="formline">
                        <Gutter />
                        <hr className="sub-header-rule"/>
                        <Button
                            className="button-plus"
                            onClick={this._addAssetClickHandler.bind(this, selectedLayer)}>
                            <SVGIcon
                                viewbox="0 0 12 12"
                                CSSID="plus" />
                        </Button>
                    </div>
                    <div className="formline">
                        <Label
                            title="Scale"
                            size="column-3">
                            Scale
                        </Label>
                        <Gutter />
                        <Label
                            title="Suffix"
                            size="column-6">
                            Suffix
                        </Label>
                        <Gutter />
                        <Label
                            title="Settings"
                            size="column-4">
                            Settings
                        </Label>
                    </div>
                    {exportComponents}
                </div>
            );
        }
    });

    module.exports = LayerExports;
});
