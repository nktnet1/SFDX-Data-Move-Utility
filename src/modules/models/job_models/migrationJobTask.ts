/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */



import { Query } from 'soql-parser-js';
import { Common } from "../../components/common_components/common";
import { DATA_MEDIA_TYPE, OPERATION, CONSTANTS, RESULT_STATUSES, MESSAGE_IMPORTANCE } from "../../components/common_components/statics";
import { Logger, RESOURCES, LOG_MESSAGE_VERBOSITY, LOG_MESSAGE_TYPE } from "../../components/common_components/logger";
import { Sfdx } from "../../components/common_components/sfdx";
import {
    composeQuery,
    getComposedField
} from 'soql-parser-js';
import { ScriptObject, MigrationJob as Job, ICSVIssues, CommandExecutionError, ScriptOrg, Script } from "..";
import SFieldDescribe from "../script_models/sfieldDescribe";
import * as path from 'path';
import * as fs from 'fs';
import { CachedCSVContent } from "./migrationJob";
import * as deepClone from 'deep.clone';
import { BulkApiV2_0Engine } from "../../components/api_engines/bulkApiV2_0Engine";
import { IApiEngine } from "../api_models/interfaces";
import ApiInfo from "../api_models/apiInfo";
import { BulkApiV1_0Engine } from "../../components/api_engines/bulkApiV1_0Engine";
import { RestApiEngine } from "../../components/api_engines/restApiEngine";




export default class MigrationJobTask {

    scriptObject: ScriptObject;
    job: Job;
    sourceTotalRecorsCount: number = 0;
    targetTotalRecorsCount: number = 0;
    apiEngine: IApiEngine;
    apiProgressCallback: (apiResult: ApiInfo) => void;


    constructor(init: Partial<MigrationJobTask>) {
        if (init) {
            Object.assign(this, init);
        }
    }

    get sObjectName(): string {
        return this.scriptObject && this.scriptObject.name;
    }

    get script(): Script {
        return this.scriptObject.script;
    }

    get logger(): Logger {
        return this.script.logger;
    }

    get operation(): OPERATION {
        return this.scriptObject.operation;
    }

    get externalId(): string {
        return this.scriptObject.externalId;
    }

    get complexExternalId(): string {
        return Common.getComplexField(this.scriptObject.externalId);
    }

    data: TaskCommonData = new TaskCommonData(this);
    sourceData: TaskOrgData = new TaskOrgData(this, true);
    targetData: TaskOrgData = new TaskOrgData(this, false);

    //------------------
    tempData = {
        /**
        true if the script object 
        related to this task 
        has some child master-detail tasks
         */
        isMasterDetailTask: false
    }



    // ----------------------- Public methods -------------------------------------------    
    /**
     * Check the structure of the CSV source file.
     *
     * @returns {Promise<void>}
     * @memberof MigrationJob
     */
    async validateCSV(): Promise<Array<ICSVIssues>> {

        let csvIssues = new Array<ICSVIssues>();

        // Check csv file --------------------------------------
        // Read the csv header row
        let csvColumnsRow = await Common.readCsvFileAsync(this.data.sourceCsvFilename, 1);

        if (csvColumnsRow.length == 0) {
            // Missing or empty file
            csvIssues.push({
                Date: Common.formatDateTime(new Date()),
                "Child sObject": this.sObjectName,
                "Child field": null,
                "Child value": null,
                "Parent sObject": null,
                "Parent field": null,
                "Parent value": null,
                "Error": this.logger.getResourceString(RESOURCES.csvFileIsEmpty)
            });
            return csvIssues;
        }


        // Check columns in the csv file ------------------------
        // Only checking for the mandatory fields (to be updated), 
        // Not checking for all fields in the query (like RecordType.DevelopeName).
        [...this.data.fieldsToUpdateMap.keys()].forEach(fieldName => {
            const columnExists = Object.keys(csvColumnsRow[0]).some(columnName => {
                columnName = columnName.trim();
                let nameParts = columnName.split('.');
                return columnName == fieldName
                    || nameParts.some(namePart => namePart == fieldName);
            });
            if (!columnExists) {
                // Column is missing in the csv file
                csvIssues.push({
                    Date: Common.formatDateTime(new Date()),
                    "Child sObject": this.sObjectName,
                    "Child field": fieldName,
                    "Child value": null,
                    "Parent sObject": null,
                    "Parent field": null,
                    "Parent value": null,
                    "Error": this.logger.getResourceString(RESOURCES.columnsMissingInCSV)
                });
            }
        });

        return csvIssues;
    }

    /**
     * Try to add missing lookup csv columns
     * - Adds missing id column on Insert operation.
     * - Adds missing lookup columns like: Account__r.Name, Account__c
     *
     * @param {CachedCSVContent} cachedCSVContent The cached content of the source csv fiels
     * @returns {Promise<Array<ICSVIssues>>}
     * @memberof MigrationJobTask
     */
    async repairCSV(cachedCSVContent: CachedCSVContent): Promise<Array<ICSVIssues>> {

        let self = this;
        let csvIssues = new Array<ICSVIssues>();

        let currentFileMap: Map<string, any> = await Common.readCsvFileOnceAsync(cachedCSVContent.csvDataCacheMap,
            this.data.sourceCsvFilename,
            null, null,
            false, false);

        if (currentFileMap.size == 0) {
            // CSV file is empty or does not exist.
            // Missing csvs were already reported. No additional report provided.
            return csvIssues;
        }

        let firstRow = currentFileMap.values().next().value;

        // Removes extra spaces from column headers
        ___trimColumnNames(firstRow);

        if (this.scriptObject.useCSVValuesMapping && this.job.csvValuesMapping.size > 0) {
            // Update csv rows with csv value mapping
            ___updateWithCSVValueMapping(firstRow);
        }

        if (!firstRow.hasOwnProperty("Id")) {
            // Add missing id column 
            ___addMissingIdColumn();

            // Update child lookup id columns
            let child__rSFields = this.scriptObject.externalIdSFieldDescribe.child__rSFields;
            for (let fieldIndex = 0; fieldIndex < child__rSFields.length; fieldIndex++) {
                const childIdSField = child__rSFields[fieldIndex].idSField;
                await ___updateChildOriginalIdColumnsAsync(childIdSField);
            }
        }

        // Add missing lookup columns 
        for (let fieldIndex = 0; fieldIndex < this.data.fieldsInQuery.length; fieldIndex++) {
            const sField = this.data.fieldsInQueryMap.get(this.data.fieldsInQuery[fieldIndex]);
            // BUG: Failed when adding multiselect column on DELHAIZE-CASE-LOAD 
            if (sField.isReference && (!firstRow.hasOwnProperty(sField.fullName__r) || !firstRow.hasOwnProperty(sField.nameId))) {
                await ___addMissingLookupColumnsAsync(sField);
            }
        }

        return csvIssues;


        // ------------------ Internal functions ------------------------- //
        /**
         * Updates csv rows according to provided value mapping file
         *
         * @param {*} firstRow
         */
        function ___updateWithCSVValueMapping(firstRow: any) {
            self.logger.infoNormal(RESOURCES.mappingRawCsvValues, self.sObjectName);
            let fields = Object.keys(firstRow);
            let csvRows = [...currentFileMap.values()];
            fields.forEach(field => {
                let key = self.sObjectName + field;
                let valuesMap = self.job.csvValuesMapping.get(key);
                if (valuesMap && valuesMap.size > 0) {
                    csvRows.forEach((csvRow: any) => {
                        let rawValue = (String(csvRow[field]) || "").trim();
                        if (valuesMap.has(rawValue)) {
                            csvRow[field] = valuesMap.get(rawValue);
                        }
                    });
                }
            });
            cachedCSVContent.updatedFilenames.add(self.data.sourceCsvFilename);
        }

        /**
         * Trim csv header columns to remove extra unvisible symbols and spaces
         *
         * @param {*} firstRow
         */
        function ___trimColumnNames(firstRow: any) {
            let columnsToUpdate = new Array<string>();
            Object.keys(firstRow).forEach(field => {
                if (field != field.trim()) {
                    columnsToUpdate.push(field);
                }
            });
            if (columnsToUpdate.length > 0) {
                let csvRows = [...currentFileMap.values()];
                columnsToUpdate.forEach(column => {
                    let newColumn = column.trim();
                    csvRows.forEach((csvRow: any) => {
                        csvRow[newColumn] = csvRow[column];
                        delete csvRow[column];
                    });
                });
                cachedCSVContent.updatedFilenames.add(self.data.sourceCsvFilename);
            }
        }

        /**
         * Add Id column to the current csv file (if it is missing), 
         * then update all its child lookup "__r" columns in other csv files
         */
        function ___addMissingIdColumn() {
            [...currentFileMap.keys()].forEach(id => {
                let csvRow = currentFileMap.get(id);
                csvRow["Id"] = id;
            });
            cachedCSVContent.updatedFilenames.add(self.data.sourceCsvFilename);
        }

        /**
         * Add all missing lookup columns (like Account__c, Account__r.Name)
         *
         * @param {SFieldDescribe} sField sField to process
         * @returns {Promise<void>}
         */
        async function ___addMissingLookupColumnsAsync(sField: SFieldDescribe): Promise<void> {
            let columnName__r = sField.fullName__r;
            let columnNameId = sField.nameId;
            let parentExternalId = sField.parentLookupObject.externalId;
            let parentTask = self.job.getTaskBySObjectName(sField.parentLookupObject.name);
            if (parentTask) {
                let parentFileMap: Map<string, any> = await Common.readCsvFileOnceAsync(cachedCSVContent.csvDataCacheMap, parentTask.data.sourceCsvFilename);
                let parentCSVRowsMap = new Map<string, any>();
                [...parentFileMap.values()].forEach(parentCsvRow => {
                    let key = parentTask.getRecordValue(parentCsvRow, parentExternalId);
                    if (key) {
                        parentCSVRowsMap.set(key, parentCsvRow);
                    }
                });
                let isFileChanged = false;
                [...currentFileMap.keys()].forEach(id => {
                    let csvRow = currentFileMap.get(id);
                    if (!csvRow.hasOwnProperty(columnNameId)) {
                        if (!csvRow.hasOwnProperty(columnName__r)) {
                            // Missing both id and __r columns 
                            //        => fill them with next incremental numbers
                            // Since the missing columns were already reported no additional report provided.
                            isFileChanged = true;
                            csvRow[columnNameId] = cachedCSVContent.nextId;
                            csvRow[columnName__r] = cachedCSVContent.nextId;
                            return;
                        }
                        // Missing id column but __r column provided.
                        let desiredExternalIdValue = parentTask.getRecordValue(csvRow, parentExternalId, self.sObjectName, columnName__r);
                        if (desiredExternalIdValue) {
                            isFileChanged = true;
                            let parentCsvRow = parentCSVRowsMap.get(desiredExternalIdValue);
                            if (!parentCsvRow) {
                                csvIssues.push({
                                    Date: Common.formatDateTime(new Date()),
                                    "Child sObject": self.sObjectName,
                                    "Child field": columnName__r,
                                    "Child value": desiredExternalIdValue,
                                    "Parent sObject": sField.parentLookupObject.name,
                                    "Parent field": parentExternalId,
                                    "Parent value": null,
                                    "Error": self.logger.getResourceString(RESOURCES.missingParentRecordForGivenLookupValue)
                                });
                                csvRow[columnNameId] = cachedCSVContent.nextId;
                            } else {
                                csvRow[columnNameId] = parentCsvRow["Id"];
                            }
                        }
                    } else if (!csvRow.hasOwnProperty(columnName__r)) {
                        if (!csvRow.hasOwnProperty(columnNameId)) {
                            // Missing both id and __r columns 
                            //        => fill them with next incremental numbers
                            // Since the missing columns were already reported no additional report provided.
                            isFileChanged = true;
                            csvRow[columnNameId] = cachedCSVContent.nextId;
                            csvRow[columnName__r] = cachedCSVContent.nextId;
                            return;
                        }
                        // Missing __r column but id column provided.
                        // Create __r column.
                        let idValue = csvRow[columnNameId];
                        if (idValue) {
                            isFileChanged = true;
                            let parentCsvRow = parentFileMap.get(idValue);
                            if (!parentCsvRow) {
                                csvIssues.push({
                                    Date: Common.formatDateTime(new Date()),
                                    "Child sObject": self.sObjectName,
                                    "Child field": columnNameId,
                                    "Child value": idValue,
                                    "Parent sObject": sField.parentLookupObject.name,
                                    "Parent field": "Id",
                                    "Parent value": null,
                                    "Error": self.logger.getResourceString(RESOURCES.missingParentRecordForGivenLookupValue)
                                });
                                csvRow[columnName__r] = cachedCSVContent.nextId;
                            } else {
                                isFileChanged = true;
                                csvRow[columnName__r] = parentCsvRow[parentExternalId];
                            }
                        }
                    }
                });
                if (isFileChanged) {
                    cachedCSVContent.updatedFilenames.add(self.data.sourceCsvFilename);
                }
            }
        }

        /**
         * When Id column was added 
         *      - updates child lookup id columns
         *      for all other objects.
         * For ex. if the current object is "Account", it will update 
         *     the child lookup id column "Account__c" of the child "Case" object
         *
         * @param {SFieldDescribe} childIdSField Child lookup id sField to process
         * @returns {Promise<void>}
         */
        async function ___updateChildOriginalIdColumnsAsync(childIdSField: SFieldDescribe): Promise<void> {
            let columnChildOriginalName__r = childIdSField.fullOriginalName__r;
            let columnChildIdName__r = childIdSField.fullIdName__r;
            let columnChildNameId = childIdSField.nameId;
            let parentOriginalExternalIdColumnName = self.scriptObject.originalExternalId;
            if (parentOriginalExternalIdColumnName != "Id") {
                let childTask = self.job.getTaskBySObjectName(childIdSField.scriptObject.name);
                if (childTask) {
                    let childFileMap: Map<string, any> = await Common.readCsvFileOnceAsync(cachedCSVContent.csvDataCacheMap, childTask.data.sourceCsvFilename);
                    let isFileChanged = false;
                    if (childFileMap.size > 0) {
                        let childCSVFirstRow = childFileMap.values().next().value;
                        if (childCSVFirstRow.hasOwnProperty(columnChildOriginalName__r)) {
                            let parentCSVExtIdMap = new Map<string, any>();
                            [...currentFileMap.values()].forEach(csvRow => {
                                let key = self.getRecordValue(csvRow, parentOriginalExternalIdColumnName);
                                if (key) {
                                    parentCSVExtIdMap.set(key, csvRow);
                                }
                            });
                            [...childFileMap.values()].forEach(csvRow => {
                                let extIdValue = self.getRecordValue(csvRow, parentOriginalExternalIdColumnName, childTask.sObjectName, columnChildOriginalName__r);
                                if (extIdValue && parentCSVExtIdMap.has(extIdValue)) {
                                    csvRow[columnChildNameId] = parentCSVExtIdMap.get(extIdValue)["Id"];
                                    csvRow[columnChildIdName__r] = csvRow[columnChildNameId];
                                    isFileChanged = true;
                                }
                            });
                        } else {
                            csvIssues.push({
                                Date: Common.formatDateTime(new Date()),
                                "Child sObject": childTask.sObjectName,
                                "Child field": columnChildOriginalName__r,
                                "Child value": null,
                                "Parent sObject": self.sObjectName,
                                "Parent field": "Id",
                                "Parent value": null,
                                "Error": self.logger.getResourceString(RESOURCES.cantUpdateChildLookupCSVColumn)
                            });
                        }
                    }
                    if (isFileChanged) {
                        cachedCSVContent.updatedFilenames.add(childTask.data.sourceCsvFilename);
                    }
                }
            }
        }

    }

    /**
     * Get record value by given property name
     *     for this sobject
     *
     * @param {*} record The record
     * @param {string} propName The property name to extract value from the record object
     * @param {string} [sObjectName] If the current task is RecordType and propName = DeveloperName - 
     *                               pass here the SobjectType
     * @param {string} [sFieldName]  If the current task is RecordType and propName = DeveloperName -
     *                               pass here the property name to extract value from the record object
     *                               instead of passing it with the "propName" parameter
     * @returns {*}
     * @memberof MigrationJobTask
     */
    getRecordValue(record: any, propName: string, sObjectName?: string, sFieldName?: string): any {
        return Common.getRecordValue(this.sObjectName, record, propName, sObjectName, sFieldName);
    }

    /**
     * Get CSV filename for this sobject including the full directory path
     *
     * @param {string} rootPath The root path to append the filename to it
     * @returns {string}
     * @memberof MigrationJobTask
     */
    getCSVFilename(rootPath: string, pattern?: string): string {
        let suffix = `${pattern || ''}.csv`;
        if (this.sObjectName == "User" || this.sObjectName == "Group") {
            return path.join(rootPath, CONSTANTS.USER_AND_GROUP_FILENAME) + suffix;
        } else {
            return path.join(rootPath, this.sObjectName) + suffix;
        }
    }

    /**
     * Creates SOQL query to retrieve records
     *
     * @param {Array<string>} [fieldNames] Field names to include in the query, 
     *                                     pass undefined value to use all fields 
     *                                      of the current task
     * @param {boolean} [removeLimits=false]  true to remove LIMIT, OFFSET, ORDERBY clauses
     * @param {Query} [parsedQuery]  Default parsed query.
     * @returns {string}
     * @memberof MigrationJobTask
     */
    createQuery(fieldNames?: Array<string>, removeLimits: boolean = false, parsedQuery?: Query): string {
        parsedQuery = parsedQuery || this.scriptObject.parsedQuery;
        let tempQuery = deepClone.deepCloneSync(parsedQuery, {
            absolute: true,
        });
        if (!fieldNames)
            tempQuery.fields = this.data.fieldsInQuery.map(fieldName => getComposedField(fieldName));
        else
            tempQuery.fields = fieldNames.map(fieldName => getComposedField(fieldName));
        if (removeLimits) {
            tempQuery.limit = undefined;
            tempQuery.offset = undefined;
            tempQuery.orderBy = undefined;
        }
        return composeQuery(tempQuery);
    }

    /**
     * Converts full query string into short form
     * to be displayed in the stdout
     *
     * @param {string} query
     * @returns {string}
     * @memberof MigrationJobTask
     */
    createShortQueryString(longString: string): string {
        let parts = longString.split("FROM");
        return parts[0].substr(0, CONSTANTS.SHORT_QUERY_STRING_MAXLENGTH) +
            (parts[0].length > CONSTANTS.SHORT_QUERY_STRING_MAXLENGTH ? "..." : "") +
            " FROM "
            + parts[1].substr(0, CONSTANTS.SHORT_QUERY_STRING_MAXLENGTH) +
            (parts[1].length > CONSTANTS.SHORT_QUERY_STRING_MAXLENGTH ? "..." : "");
    }

    /**
     * Create SOQL query to delete records
     *
     * @returns
     * @memberof MigrationJobTask
     */
    createDeleteQuery() {
        if (!this.scriptObject.parsedDeleteQuery) {
            return this.createQuery(["Id"], true);
        } else {
            return this.createQuery(["Id"], true, this.scriptObject.parsedDeleteQuery);
        }
    }

    /**
    * Retireve the total records count 
    *
    * @returns {Promise<void>}
    * @memberof MigrationJobTask
    */
    async getTotalRecordsCountAsync(): Promise<void> {

        let queryOrNumber = this.createQuery(['COUNT(Id) CNT'], true);

        if (this.sourceData.org.media == DATA_MEDIA_TYPE.Org) {
            let apiSf = new Sfdx(this.sourceData.org);
            let ret = await apiSf.queryAsync(queryOrNumber, false);
            this.sourceTotalRecorsCount = Number.parseInt(ret.records[0]["CNT"]);
            if (this.scriptObject.parsedQuery.limit) {
                this.sourceTotalRecorsCount = Math.min(this.sourceTotalRecorsCount, this.scriptObject.parsedQuery.limit);
            }
            this.logger.infoNormal(RESOURCES.totalRecordsAmount, this.sObjectName,
                this.sourceData.resourceString_Source_Target, String(this.sourceTotalRecorsCount));
        }

        if (this.targetData.org.media == DATA_MEDIA_TYPE.Org) {
            let apiSf = new Sfdx(this.targetData.org);
            let ret = await apiSf.queryAsync(queryOrNumber, false);
            this.targetTotalRecorsCount = Number.parseInt(ret.records[0]["CNT"]);
            if (this.scriptObject.parsedQuery.limit) {
                this.targetTotalRecorsCount = Math.min(this.targetTotalRecorsCount, this.scriptObject.parsedQuery.limit);
            }
            this.logger.infoNormal(RESOURCES.totalRecordsAmount, this.sObjectName,
                this.targetData.resourceString_Source_Target, String(this.targetTotalRecorsCount));
        }
    }

    /**
     * Delete old records from the target org
     *
     * @returns {Promise<void>}
     * @memberof MigrationJobTask
     */
    async deleteOldTargetRecords(): Promise<boolean> {
        // Checking
        if (!(this.targetData.org.media == DATA_MEDIA_TYPE.Org
            && this.scriptObject.operation != OPERATION.Readonly
            && this.scriptObject.deleteOldData)) {
            this.logger.infoNormal(RESOURCES.nothingToDelete, this.sObjectName);
            return false;
        }
        // Querying
        this.logger.infoNormal(RESOURCES.deletingTargetSObject, this.sObjectName);
        let soql = this.createDeleteQuery();
        let apiSf = new Sfdx(this.targetData.org);
        let queryResult = await apiSf.queryAsync(soql, this.targetData.useBulkQueryApi);
        if (queryResult.totalSize == 0) {
            this.logger.infoNormal(RESOURCES.nothingToDelete, this.sObjectName);
            return false;
        }
        // Deleting
        this.logger.infoVerbose(RESOURCES.deletingFromTheTargetNRecordsWillBeDeleted, this.sObjectName, String(queryResult.totalSize));
        let recordsToDelete = queryResult.records.map(x => {
            return {
                Id: x["Id"]
            }
        });
        this.createApiEngine(this.targetData.org, OPERATION.Delete, recordsToDelete.length, true);

        // TODO*PUTBACKIT! Enable rows below to delete records
        // let resultRecords = await this.apiEngine.executeCRUD(recordsToDelete, this.apiProgressCallback);
        // if (resultRecords == null) {
        //     // API ERROR. Exiting.
        //     this._apiOperationError(OPERATION.Delete);
        // }

        // Done
        this.logger.infoVerbose(RESOURCES.deletingFromTheTargetCompleted, this.sObjectName);
        return true;
    }

    /**
     * Retrieve records for this task
     * 
     * @param {number} queryMode The mode of record processing
     * @param {boolean} reversed If TRUE - queries from the child related object to parent object
     *                           (selects all parent objects that exist in the child objects)
     *                                      forward:   parent <== *child (before, prev)
     *                                      backward:  *child ==> parent (after, next)
     *                           If FALSE - queries from the parent related object to child object
     *                           (selects all child objects that exist in the parent objects)
     *                                      forward:   child ==> *parent (before, prev)
     *                                      backward:  *parent <== child (after, next)
     * @returns {Promise<void>}
     * @memberof MigrationJobTask
     */
    async retrieveRecords(queryMode: "forwards" | "backwards" | "target", reversed: boolean): Promise<void> {

        let self = this;

        // Checking status *********
        if (this.operation == OPERATION.Delete) return;

        let records: Array<any> = new Array<any>();

        // Read SOURCE DATA *********************************************************************************************
        // **************************************************************************************************************
        let hasRecords = false;
        if (queryMode != "target") {
            // Read main data *************************************
            // ****************************************************
            if (this.sourceData.org.media == DATA_MEDIA_TYPE.File && queryMode == "forwards") {
                // Read from the SOURCE CSV FILE ***********************************
                let query = this.createQuery();
                // Start message ------
                this.logger.infoNormal(RESOURCES.queryingAll, this.sObjectName, this.sourceData.resourceString_Source_Target, this.data.resourceString_csvFile, this.data.resourceString_Step(queryMode));
                let sfdx = new Sfdx(this.targetData.org);
                records = await sfdx.retrieveRecordsAsync(query, false, this.data.sourceCsvFilename, this.targetData.fieldsMap);
                hasRecords = true;
            } else {
                // Read from the SOURCE ORG **********************************************
                if (this.scriptObject.processAllSource && queryMode == "forwards") {
                    // All records *********** //
                    let query = this.createQuery();
                    // Start message ------
                    this.logger.infoNormal(RESOURCES.queryingAll, this.sObjectName, this.sourceData.resourceString_Source_Target, this.data.resourceString_org,
                        this.data.resourceString_Step(queryMode));
                    // Query string message ------    
                    this.logger.infoVerbose(RESOURCES.queryString, this.sObjectName, this.createShortQueryString(query));
                    // Fetch records                
                    let sfdx = new Sfdx(this.sourceData.org);
                    records = await sfdx.retrieveRecordsAsync(query, this.sourceData.useBulkQueryApi);
                    hasRecords = true;
                } else if (!this.scriptObject.processAllSource) {
                    // Filtered records ************ //
                    let queries = this._createFilteredQueries(queryMode, reversed);
                    if (queries.length > 0) {
                        // Start message ------
                        this.logger.infoNormal(RESOURCES.queryingIn, this.sObjectName, this.sourceData.resourceString_Source_Target, this.data.resourceString_org, this.data.resourceString_Step(queryMode));
                        // Fetch records
                        records = await ___retrieveFilteredRecords(queries, this.sourceData);
                        hasRecords = true;
                    }
                }
            }
            if (hasRecords) {
                // Set external id map ---------
                let newRecordsCount = ___setExternalIdMap(records, this.sourceData.extIdRecordsMap, this.sourceData.idRecordsMap);
                // Completed message ------
                this.logger.infoNormal(RESOURCES.queryingFinished, this.sObjectName, this.sourceData.resourceString_Source_Target, String(newRecordsCount));
            }

            // Read SELF REFERENCE records from the SOURCE *************
            // *********************************************************
            if (this.sourceData.org.media == DATA_MEDIA_TYPE.Org && queryMode == "forwards") {
                records = new Array<any>();
                let inValues: Array<string> = new Array<string>();
                for (let fieldIndex = 0; fieldIndex < this.data.fieldsInQuery.length; fieldIndex++) {
                    const describe = this.data.fieldsInQueryMap.get(this.data.fieldsInQuery[fieldIndex]);
                    if (describe.isSimpleSelfReference) {
                        [...this.sourceData.idRecordsMap.values()].forEach(sourceRec => {
                            if (sourceRec[describe.name]) {
                                inValues.push(sourceRec[describe.name]);
                            }
                        });
                    }
                }
                if (inValues.length > 0) {
                    // Start message ------
                    this.logger.infoNormal(RESOURCES.queryingSelfReferenceRecords, this.sObjectName, this.sourceData.resourceString_Source_Target);
                    inValues = Common.distinctStringArray(inValues);
                    let sfdx = new Sfdx(this.sourceData.org);
                    let queries = Common.createFieldInQueries(this.data.fieldsInQuery, "Id", this.sObjectName, inValues);
                    for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
                        const query = queries[queryIndex];
                        // Query string message ------
                        this.logger.infoVerbose(RESOURCES.queryString, this.sObjectName, this.createShortQueryString(query));
                        // Fetch records
                        records = records.concat(await sfdx.retrieveRecordsAsync(query));
                    }
                    if (queries.length > 0) {
                        // Set external id map ---------
                        let newRecordsCount = ___setExternalIdMap(records, this.sourceData.extIdRecordsMap, this.sourceData.idRecordsMap);
                        // Completed message ------
                        this.logger.infoNormal(RESOURCES.queryingFinished, this.sObjectName, this.sourceData.resourceString_Source_Target, String(newRecordsCount));
                    }
                }
            }
        }


        // Read TARGET DATA ***********************************************************************************
        // ****************************************************************************************************
        if (queryMode == "target") {
            hasRecords = false;
            if (this.targetData.org.media == DATA_MEDIA_TYPE.Org && this.operation != OPERATION.Insert) {
                // Read from the TARGET ORG *********
                records = new Array<any>();
                if (this.scriptObject.processAllTarget) {
                    // All records ****** //
                    let query = this.createQuery();
                    // Start message ------
                    this.logger.infoNormal(RESOURCES.queryingAll, this.sObjectName, this.targetData.resourceString_Source_Target, this.data.resourceString_org, this.data.resourceString_Step(queryMode));
                    // Query string message ------
                    this.logger.infoVerbose(RESOURCES.queryString, this.sObjectName, this.createShortQueryString(query));
                    // Fetch records
                    let sfdx = new Sfdx(this.targetData.org);
                    records = await sfdx.retrieveRecordsAsync(query, this.targetData.useBulkQueryApi);
                    hasRecords = true;
                } else {
                    // Filtered records ***** //
                    let queries = this._createFilteredQueries(queryMode, reversed);
                    if (queries.length > 0) {
                        // Start message ------
                        this.logger.infoNormal(RESOURCES.queryingIn, this.sObjectName, this.targetData.resourceString_Source_Target, this.data.resourceString_org, this.data.resourceString_Step(queryMode));
                        // Fetch records
                        records = await ___retrieveFilteredRecords(queries, this.targetData);
                        hasRecords = true;
                    }
                }
            }
            if (hasRecords) {
                // Set external id map ---------
                let newRecordsCount = ___setExternalIdMap(records, this.targetData.extIdRecordsMap, this.targetData.idRecordsMap);
                // Completed message ------
                this.logger.infoNormal(RESOURCES.queryingFinished, this.sObjectName, this.targetData.resourceString_Source_Target, String(newRecordsCount));
            }
        }


        // ------------------------ Internal functions --------------------------
        /**
         * @returns {number} New records count
         */
        function ___setExternalIdMap(records: Array<any>,
            sourceExtIdRecordsMap: Map<string, string>,
            sourceIdRecordsMap: Map<string, string>): number {

            let newRecordsCount = 0;
            records.forEach(record => {
                let value = self.getRecordValue(record, self.complexExternalId);
                if (value) {
                    sourceExtIdRecordsMap.set(value, record["Id"]);
                }
                if (record["Id"]) {
                    if (!sourceIdRecordsMap.has(record["Id"])) {
                        sourceIdRecordsMap.set(record["Id"], record);
                        newRecordsCount++;
                    }
                }
            });
            return newRecordsCount;
        }

        async function ___retrieveFilteredRecords(queries: string[], orgData: TaskOrgData): Promise<Array<any>> {
            let sfdx = new Sfdx(orgData.org);
            let records = new Array<any>();
            for (let index = 0; index < queries.length; index++) {
                const query = queries[index];
                // Query message ------
                self.logger.infoVerbose(RESOURCES.queryString, self.sObjectName, self.createShortQueryString(query));
                // Fetch records
                records = records.concat(await sfdx.retrieveRecordsAsync(query, false));
            }
            return records;
        }

    }

    /**
     * Perform record update
     *
     * @returns {Promise<void>}
     * @memberof MigrationJobTask
     */
    async updateRecords(): Promise<void> {
        // HACK: Implement updateRecords()



        // ------------------------ Internal functions --------------------------
        async function ___filterTargetRecords() {
            // HACK: Implement ___filterTargetRecords
            //targetRecordsFilter....
        }

    }

    /**
     * Creates new api engine for the given org and operation
     *
     * @param {ScriptOrg} org The org to connect the api engine
     * @param {OPERATION} operation The operation to perform
     * @param {boolean} updateRecordId Allow update Id property 
     *                                of the processed (the source) records 
     *                                with the target record ids
     * @param {number} amountOfRecordsToProcess The total amount of records that should 
     *                                          be processed using this engine instance
     * @returns {IApiEngine}
     * @memberof MigrationJobTask
     */
    createApiEngine(org: ScriptOrg, operation: OPERATION, amountOfRecordsToProcess: number, updateRecordId: boolean): IApiEngine {

        if (amountOfRecordsToProcess > this.script.bulkThreshold && !this.script.alwaysUseRestApiToUpdateRecords) {
            // Use bulk api
            switch (this.script.bulkApiVersionNumber) {
                case 2: // Bulk Api V2.0
                    this.apiEngine = new BulkApiV2_0Engine({
                        logger: this.logger,
                        connectionData: org.connectionData,
                        sObjectName: this.sObjectName,
                        operation,
                        pollingIntervalMs: this.script.pollingIntervalMs,
                        updateRecordId,
                        targetCSVFullFilename: this.data.targetCSVFilename(operation),
                        createTargetCSVFiles: this.script.createTargetCSVFiles
                    });
                    break;
                default: // Bulk Api V1.0
                    this.apiEngine = new BulkApiV1_0Engine({
                        logger: this.logger,
                        connectionData: org.connectionData,
                        sObjectName: this.sObjectName,
                        operation,
                        pollingIntervalMs: this.script.pollingIntervalMs,
                        updateRecordId,
                        bulkApiV1BatchSize: this.script.bulkApiV1BatchSize,
                        targetCSVFullFilename: this.data.targetCSVFilename(operation),
                        createTargetCSVFiles: this.script.createTargetCSVFiles
                    });
                    break;
            }
        } else {
            // Use rest api
            this.apiEngine = new RestApiEngine({
                logger: this.logger,
                connectionData: org.connectionData,
                sObjectName: this.sObjectName,
                operation,
                pollingIntervalMs: this.script.pollingIntervalMs,
                updateRecordId,
                allOrNone: this.script.allOrNone,
                targetCSVFullFilename: this.data.targetCSVFilename(operation),
                createTargetCSVFiles: this.script.createTargetCSVFiles
            });
        }
        this.apiProgressCallback = this.apiProgressCallback || this._apiProgressCallback.bind(this);
        return this.apiEngine;
    }


    // ----------------------- Private members -------------------------------------------
    private _apiProgressCallback(apiResult: ApiInfo): void {

        let verbosity = LOG_MESSAGE_VERBOSITY.MINIMAL;
        let logMessageType = LOG_MESSAGE_TYPE.STRING;

        switch (apiResult.messageImportance) {
            case MESSAGE_IMPORTANCE.Low:
                verbosity = LOG_MESSAGE_VERBOSITY.VERBOSE;
                break;
            case MESSAGE_IMPORTANCE.Normal:
                verbosity = LOG_MESSAGE_VERBOSITY.NORMAL;
                break;
            case MESSAGE_IMPORTANCE.Warn:
                logMessageType = LOG_MESSAGE_TYPE.WARN;
                break;
            case MESSAGE_IMPORTANCE.Error:
                logMessageType = LOG_MESSAGE_TYPE.ERROR;
                break;
        }
        switch (apiResult.resultStatus) {
            case RESULT_STATUSES.Information:
                if (apiResult.informationMessageData.length > 0) {
                    // [0] - always is the RESOURCE message
                    // [1...] - the rest of the RESOURCE message tokens
                    let resourceString = this.logger.getResourceString.apply(this.logger, [apiResult.informationMessageData[0], ...apiResult.informationMessageData.slice(1)])
                    this.logger.log.apply(this.logger, [resourceString, logMessageType, verbosity]);
                }
                break;
            case RESULT_STATUSES.ApiOperationStarted:
                this.logger.log(RESOURCES.apiOperationStarted, logMessageType, verbosity, this.sObjectName, this.apiEngine.getStrOperation(), this.apiEngine.getEngineName());
                break;
            case RESULT_STATUSES.ApiOperationFinished:
                this.logger.log(RESOURCES.apiOperationFinished, logMessageType, verbosity, this.sObjectName, this.apiEngine.getStrOperation());
                break;
            case RESULT_STATUSES.JobCreated:
                this.logger.log(RESOURCES.apiOperationJobCreated, logMessageType, verbosity, apiResult.jobId, this.apiEngine.getStrOperation(), this.sObjectName);
                break;
            case RESULT_STATUSES.BatchCreated:
                this.logger.log(RESOURCES.apiOperationBatchCreated, logMessageType, verbosity, apiResult.batchId, this.apiEngine.getStrOperation(), this.sObjectName);
                break;
            case RESULT_STATUSES.DataUploaded:
                this.logger.log(RESOURCES.apiOperationDataUploaded, logMessageType, verbosity, apiResult.batchId, this.apiEngine.getStrOperation(), this.sObjectName);
                break;
            case RESULT_STATUSES.InProgress:
                this.logger.log(RESOURCES.apiOperationInProgress, logMessageType, verbosity, apiResult.batchId, this.apiEngine.getStrOperation(), this.sObjectName, String(apiResult.numberRecordsProcessed), String(apiResult.numberRecordsFailed));
                break;
            case RESULT_STATUSES.Completed:
                this.logger.log(logMessageType != LOG_MESSAGE_TYPE.WARN ? RESOURCES.apiOperationCompleted : RESOURCES.apiOperationWarnCompleted, logMessageType, verbosity, apiResult.batchId, this.apiEngine.getStrOperation(), this.sObjectName, String(apiResult.numberRecordsProcessed), String(apiResult.numberRecordsFailed));
                break;
            case RESULT_STATUSES.ProcessError:
            case RESULT_STATUSES.FailedOrAborted:
                if (apiResult.errorMessage)
                    this.logger.log(RESOURCES.apiOperationProcessError, logMessageType, verbosity, this.sObjectName, this.apiEngine.getStrOperation(), apiResult.errorMessage);
                else
                    this.logger.log(RESOURCES.apiOperationFailed, logMessageType, verbosity, this.sObjectName, this.apiEngine.getStrOperation());
                break;
        }
    }

    private _apiOperationError(operation: OPERATION) {
        throw new CommandExecutionError(this.logger.getResourceString(RESOURCES.apiOperationFailed, this.sObjectName, this.apiEngine.getStrOperation()));
    }

    private _createFilteredQueries(queryMode: "forwards" | "backwards" | "target", reversed: boolean): Array<string> {

        let self = this;
        let queries = new Array<string>();
        let fieldsToQueryMap: Map<SFieldDescribe, Array<string>> = new Map<SFieldDescribe, Array<string>>();
        let isSource = queryMode != "target";

        let prevTasks = this.job.tasks.filter(task => this.job.tasks.indexOf(task) < this.job.tasks.indexOf(this));
        let nextTasks = this.job.tasks.filter(task => this.job.tasks.indexOf(task) > this.job.tasks.indexOf(this));

        if (reversed) {
            if (CONSTANTS.NOT_TO_USE_IN_FILTERED_QUERYIN_CLAUSE.indexOf(this.sObjectName) < 0) {
                // ONLY SOURCE + FORWARDS FOR reversed == true !
                let fields: SFieldDescribe[] = Common.flatMap([...this.data.fieldsInQueryMap.values()]
                    .filter(field => field.child__rSFields.length > 0), (field: SFieldDescribe) => {
                        return field.child__rSFields.map(f => f.idSField);
                    });
                let values = new Array<string>();
                fields.forEach((field: SFieldDescribe) => {
                    values = values.concat([...field.scriptObject.task.sourceData.idRecordsMap.values()]
                        .map((value: any) => value[field.nameId])
                        .filter(value => !!value));
                });
                values = Common.distinctStringArray(values);
                fieldsToQueryMap.set(new SFieldDescribe({
                    name: "Id"
                }), values);
            }
        } else {
            [...this.data.fieldsInQueryMap.values()].forEach(field => {
                if (isSource) {
                    // SOURCE
                    // For source => |SOURCE Case|Account__c IN (|SOURCE Account|Id....)            
                    if (field.isSimpleReference && CONSTANTS.NOT_TO_USE_IN_FILTERED_QUERYIN_CLAUSE.indexOf(field.referencedObjectType) < 0) {
                        // Only for simple reference lookup fields (f.ex.: Account__c)
                        if (!field.parentLookupObject.task.sourceData.allRecords || field.parentLookupObject.isLimitedQuery) {
                            if (queryMode != "forwards") {
                                // FORWARDS
                                // For forwards => build the query using all the PREVIOUS related tasks by the tasks order
                                if (prevTasks.indexOf(field.parentLookupObject.task) >= 0) {
                                    // The parent task is before => create child lookup query for all Id values of the parent lookup object
                                    fieldsToQueryMap.set(field, [...field.parentLookupObject.task.sourceData.idRecordsMap.keys()]);
                                }
                            } else {
                                // BACKWARDS
                                // For backwards => build the query using all the NEXT related tasks by the tasks order
                                if (nextTasks.indexOf(field.parentLookupObject.task) >= 0) {
                                    // The parent task is before => create child lookup query for all Id values of the parent lookup object
                                    fieldsToQueryMap.set(field, [...field.parentLookupObject.task.sourceData.idRecordsMap.keys()]);
                                }
                            }
                        }
                    }
                } else {
                    // TARGET
                    // For target => |TARGET Account|Name IN (|SOURCE Account|Name....)
                    if (field.isSimple && field.isExternalIdField) {
                        // Only for current object's external id (f.ex.: Name) - not complex and not Id - only simple
                        fieldsToQueryMap.set(field, [...this.sourceData.extIdRecordsMap.keys()].map(value => Common.getFieldValue(this.sObjectName, value, field.name)));
                    }
                }
            });
        }

        if (isSource && self.scriptObject.isLimitedQuery && !reversed) {
            queries.push(this.createQuery());
        }
        fieldsToQueryMap.forEach((inValues, field) => {
            if (inValues.length > 0) {
                Common.createFieldInQueries(self.data.fieldsInQuery, field.name, this.sObjectName, inValues).forEach(query => {
                    queries.push(query);
                });
            }
        });
        return queries;

    }

}

// ---------------------------------------- Helper classes ---------------------------------------------------- //
class TaskCommonData {

    task: MigrationJobTask;

    constructor(task: MigrationJobTask) {
        this.task = task;
    }

    get fieldsToUpdateMap(): Map<string, SFieldDescribe> {
        return this.task.scriptObject.fieldsToUpdateMap;
    }
    get fieldsInQueryMap(): Map<string, SFieldDescribe> {
        return this.task.scriptObject.fieldsInQueryMap;
    }
    get fieldsToUpdate(): string[] {
        return this.task.scriptObject.fieldsToUpdate;
    }
    get fieldsInQuery(): string[] {
        return this.task.scriptObject.fieldsInQuery;
    }
    get csvFilename(): string {
        return this.task.getCSVFilename(this.task.script.basePath);
    }
    get sourceCsvFilename(): string {
        let filepath = path.join(this.task.script.basePath, CONSTANTS.CSV_SOURCE_SUB_DIRECTORY);
        if (!fs.existsSync(filepath)) {
            fs.mkdirSync(filepath);
        }
        return this.task.getCSVFilename(filepath, CONSTANTS.CSV_SOURCE_FILE_SUFFIX);
    }
    targetCSVFilename(operation: OPERATION): string {
        let filepath = path.join(this.task.script.basePath, CONSTANTS.CSV_TARGET_SUB_DIRECTORY);
        if (!fs.existsSync(filepath)) {
            fs.mkdirSync(filepath);
        }
        return this.task.getCSVFilename(filepath, `_${ScriptObject.getStrOperation(operation).toLowerCase()}${CONSTANTS.CSV_TARGET_FILE_SUFFIX}`);
    }
    get resourceString_csvFile(): string {
        return this.task.logger.getResourceString(RESOURCES.csvFile);
    }
    get resourceString_org(): string {
        return this.task.logger.getResourceString(RESOURCES.org);
    }
    resourceString_Step(mode: "forwards" | "backwards" | "target"): string {
        return mode == "forwards" ? this.task.logger.getResourceString(RESOURCES.Step1)
            : this.task.logger.getResourceString(RESOURCES.Step2);
    }
}

class TaskOrgData {

    task: MigrationJobTask;
    isSource: boolean;

    extIdRecordsMap: Map<string, string> = new Map<string, string>();
    idRecordsMap: Map<string, string> = new Map<string, string>();

    constructor(task: MigrationJobTask, isSource: boolean) {
        this.task = task;
        this.isSource = isSource;
    }

    get org(): ScriptOrg {
        return this.isSource ? this.task.script.sourceOrg : this.task.script.targetOrg;
    }
    get useBulkQueryApi(): boolean {
        return this.isSource ? this.task.sourceTotalRecorsCount > CONSTANTS.QUERY_BULK_API_THRESHOLD :
            this.task.targetTotalRecorsCount > CONSTANTS.QUERY_BULK_API_THRESHOLD;
    }
    get fieldsMap(): Map<string, SFieldDescribe> {
        return this.isSource ? this.task.scriptObject.sourceSObjectDescribe.fieldsMap :
            this.task.scriptObject.targetSObjectDescribe.fieldsMap;
    }
    get resourceString_Source_Target(): string {
        return this.isSource ? this.task.logger.getResourceString(RESOURCES.source) :
            this.task.logger.getResourceString(RESOURCES.target);
    }
    get allRecords(): boolean {
        return this.isSource ? this.task.scriptObject.processAllSource : this.task.scriptObject.processAllTarget;
    }


}