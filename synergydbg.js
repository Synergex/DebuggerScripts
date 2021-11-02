"use strict";

function hostModule()
{
    const regexPath = /^(.*[\\\/])(.*)$/;

    // execute the match on the string str
    const match = regexPath.exec(host.currentProcess.Modules[0].Name);
    if (match !== null) {
        // we ignore the match[0] because it's the match for the hole path string
        //const filePath = match[1];
        return match[2];
    }
}

function findSymbol(name)
{
    var moduleName = hostModule();
    return host.getModuleSymbol(moduleName, name);  
}

function GetFileNameFromHandle(handle)
{
    return host.evaluateExpression("!handle " + host.memory.readMemoryValues(handle, 1));
}

function synergyCallFrames()
{
    var currentFrame = findSymbol("g_fptr");
    var result = [];
    while(currentFrame != null && !currentFrame.isNull)
    {
        var currentFrameValue = currentFrame.dereference();
        result.push(currentFrameValue);
        currentFrame = currentFrameValue.prev
    }
    return result;
}

function readString(obj, length)
{
    if(length != undefined)
        return host.memory.readString(obj, length);
    else
        return host.memory.readString(obj);
}

function getArguments(frame)
{
    var DSC_A =	0x0010;	/*   Alpha				*/
    var DSC_I = 0x0020;	/*   Integer				*/
    var DSC_D = 0x0040;	/*   Decimal				*/
    var DSC_ID = 0x0080;	/*   Implied Decimal			*/
    var DSC_DIM = 0x0400; /*   Dimensioned			*/
    var DSC_OHND = 0x4000;	/*   Object handle			*/
    if(frame.xargp.isNull)
        return [];

    var argBlockSize = host.memory.readMemoryValues(frame.xargp, 1, 4, false);
    var resultArgs = [];
    for(var i = 1; i <= argBlockSize; i++)
    {
        var descr = frame.xargp[i];

        var descrVal = descr.dereference();
        var argValue = "";

        if(descrVal.ctl & DSC_DIM == DSC_DIM)
        {
            argValue = "{array}";
        }
        else
        {
            if(descrVal.ctl & DSC_A)
            {
                argValue = '"' + readString(descrVal.addr, descrVal.len) + '"';
            }
            else if(descrVal.ctl & DSC_I)
            {
                argValue = host.memory.readMemoryValues(descrVal.addr, 1, descrVal.len, true);
            }
            else if(descrVal.ctl & DSC_D)
            {
                argValue = readString(descrVal.addr, descrVal.len);
            }
            else if(descrVal.ctl & DSC_ID)
            {
                argValue = readString(descrVal.addr, descrVal.len);
            }
            else if(descrVal.ctl & DSC_OHND)
            {
                argValue = "{object}";
            }
        }
        resultArgs.push(argValue);
    }
    return resultArgs;
}

function showTraceback()
{
    var callFrames = synergyCallFrames();
    var result = [];
    var first = true;
    for(var frame of callFrames)
    {
        var mptr = frame.mptr;
        if(mptr != null)
        {
            var sourceInfo = pcToSource(mptr, first ? mptr.exitpc : findSymbol("g_dblpc"));
            var owner = mptr.dereference().owner;
            var name = readString(owner.dereference().se_name);
            result.push(`${name}(${getArguments(frame).join(",")}) -> ${sourceInfo.SourceFile} : ${sourceInfo.LineNumber}`);
        }
        first = false;
    }
    return result;
}

function showChannels()
{
    var gchan = findSymbol("g_channels");
    let maxChan = 1024 + 7;
    
    var result = []
    for(var i = 0; i < maxChan; i++)
    {
        
        var chan = gchan[i];
        if(!chan.isNull)
        {
            
            result.push(`Channel Number = ${i} File Name = "${readString(chan.io_filnam)}" Flags = ${new IOCB_FileTypeFlags(chan.io_flags).stringify()} Mode = ${new IOCB_FileModeTypes(chan.io_mode).stringify()}`);
        }
    }

    return result;
}

function getHandles(dynctl, isGlobal)
{
    var result = [];
    if(dynctl.isNull || dynctl.size == 0)
        return result;

    var lastIndex = dynctl.last;

    for(var i = 1; i <= lastIndex; i++)
    {
        var dynhand = dynctl.base[i];
        var handleType = new HandleTypes(dynhand.type)
        var typeString = handleType.stringify();
        if(handleType.isMemory)
        {
            var maxDisplaySize = Math.min(dynhand.size, 120);
            result.push(`Scope = ${isGlobal ? "Global" : "Local"} Type = ${typeString} Size = ${dynhand.size} Address = ${dynhand.addr.address} Value = ${readString(dynhand.addr, maxDisplaySize)}`);
        }
        else
        {
            result.push(`Scope = ${isGlobal ? "Global" : "Local"} Type = ${typeString} Size = ${dynhand.size} Address = ${dynhand.addr.address}`);
        }
        
    }

    return result;
}

function showHandles()
{
    var globalDynmem = findSymbol("g_dm_gctl");
    var localDynmem = findSymbol("g_dm_lctl");
    return getHandles(globalDynmem, true).concat(getHandles(localDynmem, false))
}

function sourceNumberToName(mptr, sourceNumber)
{
    var currentHostName = hostModule();
    var srcTable = mptr.linctl.address.add(mptr.srcfiles);
    var nextSource = host.createPointerObject(srcTable, currentHostName, "V9SRC *");
    while(!nextSource.isNull && nextSource.dereference().srcnum != sourceNumber)
    {
        var nextSourceVal = nextSource.dereference();
        var nextAddress = mptr.linctl.address.add(nextSourceVal.next);
        nextSource = host.createPointerObject(nextAddress, currentHostName, "V9SRC *");
    }
    return host.memory.readString(nextSource.dereference().name);
}

function pcToSource(mptr, dblpc)
{
    var currentHostName = hostModule();
    var pcOffset = dblpc - mptr.code;
    var psegTable = mptr.linctl.address.add(mptr.psegtbl);
    var psegTableTyped = host.createPointerObject(psegTable, currentHostName, "V9PSEG *");
    
    var targetPSeg = psegTableTyped[1];
    var currentLineNumber = 0;
    var segIndex = 1;
    if (!((pcOffset > 0XFFFF) || (pcOffset < 0)))
    {
        while (targetPSeg.dblpc < pcOffset)	/* Find the V9PSEG entry	*/
        {
	        targetPSeg = psegTableTyped[segIndex++];
        }
    }

    //var pcp = host.createPointerObject(mptr.linctl.address.add(targetPSeg.ctlndxl), currentHostName, "V9PSEG *");
    //var pcpIndex = 0;
	//var ix = (psegTableTyped[segIndex].ctlndx - targetPSeg.ctlndx);
    //var lincnt = 0;
	//while ((--ix >= 0) && (pcp[pcpIndex] < pcOffset))
    //{
    //    pcpIndex++;
    //    lincnt++;
    //}


    return { SourceFile: sourceNumberToName(mptr, targetPSeg.srcnum), LineNumber: currentLineNumber };
}

class IOCB_FileTypeFlags
{ 
    constructor(flagValue)
    {
        this.flagValue = flagValue;
        this.FT_TYPE = 0x0FF2;		/* File type only		*/
        this.FT_LOCAL = 0x0000;		/* Local file			*/
        this.FT_REMOTE = 0x0001;		/* Remote file			*/
        this.FT_DBLISAM = 0x0002;		/* Synergy DBL ISAM file	*/
        this.FT_DBLFLAT = 0x0004;	/* Synergy DBL Non-ISAM file	*/
        this.FT_CISAM = 0x0008;		/* Informix C-ISAM file		*/
        this.FT_TIS = 0x0010;		/* Trifox RDB file		*/
        this.FT_PIPECMD = 0x0020;		/* Open pipe command		*/
        this.FT_AS400 = 0x0040;		/* AS/400 native file		*/
        this.FT_BTRV	= 0x0040;		/* Novell's Btreive 		*/
        this.FT_NETTHREAD = 0x0800;		/* channel is a server thread channel */
        this.FT_PCLOSE = 0x1000;		/* Pending close (file closed)	*/
        this.FT_BADHOST = 0x8000;		/* Bad hostname			*/

        this.FT_ODBCUPDATE = 0x0080;		/* ODBC update channel		*/
        this.FT_ODBCINPUT = 0x0100;		/* ODBC input channel		*/
        this.FT_ODBCLASTFIND	= 0x0200;		/* ODBC last op was find	*/
        this.FT_ODBCISAM	= 0x0400;		/* ODBC isam channel		*/
    }
    
    isLocal()
    {
        return !(this.flagValue & REMOTE);
    }

    stringify()
    {
        var stringValues = [];
        if(this.flagValue & this.FT_TYPE)
            stringValues.push("File");
        if(this.flagValue & this.FT_REMOTE)
            stringValues.push("Remote");
        else
            stringValues.push("Local");

        if(this.flagValue & this.FT_DBLISAM)
            stringValues.push("ISAM");
        
        if(this.flagValue & this.FT_DBLFLAT)
            stringValues.push("Flat");

        if(this.flagValue & this.FT_PIPECMD)
            stringValues.push("Pipe");

        if(this.flagValue & this.FT_PCLOSE)
            stringValues.push("Pending Close");
        
        if(this.flagValue & this.FT_BADHOST)
            stringValues.push("Bad Host");

        if(this.flagValue & this.FT_ODBCUPDATE)
            stringValues.push("ODBC Update");

        if(this.flagValue & this.FT_ODBCINPUT)
            stringValues.push("ODBC Input");

        if(this.flagValue & this.FT_ODBCLASTFIND)
            stringValues.push("ODBC LastFind");

        if(this.flagValue & this.FT_ODBCISAM)
            stringValues.push("ODBC ISAM");

        return stringValues.join("|");
    }
}

class IOCB_FileModeTypes
{
    constructor(flagValue)
    {
        this.CS_I = 0x0001		/* Input mode			*/
        this.CS_O = 0x0002		/* Output mode			*/
        this.CS_U = 0x0004		/* Update mode			*/
        this.CS_A = 0x0008		/* Append mode			*/
        this.CS_SEQ	= 0x000010	/* Sequential submode		*/
        this.CS_REL	= 0x000020	/* Relative submode		*/
        this.CS_IDX	= 0x000040	/* ISAM submode			*/
        this.CS_BLK	= 0x000080	/* Block submode		*/
        this.CS_PRT	= 0x000100	/* Print submode		*/
        this.CS_DBL	 = 0x000200	/* Default submode (stream)	*/
        this.CS_RMSIDX = 0x000400	/* RMS ISAM submode		*/
        this.CS_CDCHECK	= 0x000400	/* cd checking on DOS/SFW serial port */
        this.CS_TERMINAL = 0x000800	/* Channel is a terminal	*/
        this.CS_CONSOLE	= 0x001000	/* Channel is a console		*/
        this.CS_CHRDEV = 0x002000	/* Channel is a character dev	*/
        this.CS_BLKDEV = 0x004000	/* Channel is a block device	*/
        this.CS_PIPE = 0x008000	/* Channel is a pipe		*/
        this.CS_PRINTER	= 0x010000	/* Channel is a printer		*/
        this.CS_BUFFERED = 0x020000	/* Channel is buffered		*/
        this.CS_MAILBOX	= 0x040000	/* Channel is VMS mailbox	*/
        this.CS_LAT	= 0x080000	/* Channel is VMS LAT terminal	*/
        this.CS_DOSNUL = 0x080000	/* Channel is Windows NUL device */
        this.CS_TCPIP = 0x100000	/* Channel is a tcp/ip device	*/
        this.CS_NETDEV = 0x200000	/* Channel is a network device	*/
        this.CS_RECDEV = 0x400000	/* Channel is a record device	*/
        this.CS_DEC_OP = 0x800000	/* Funny DEC O:P SEQ file	*/
        this.CS_DOSCOM = 0x1000000	/* Channel is Windows comport 	*/
        this.CS_TEMP = 0x4000000	/* Temporary file is active	*/
    }

    stringify()
    {
        var stringValues = [];
        if(this.flagValue & this.CS_I)
            stringValues.push("I");
        if(this.flagValue & this.CS_O)
            stringValues.push("O");
        if(this.flagValue & this.CS_U)
            stringValues.push("U");
        if(this.flagValue & this.CS_A)
            stringValues.push("A");
        if(this.flagValue & this.CS_SEQ)
            stringValues.push("SEQ");
        if(this.flagValue & this.CS_REL)
            stringValues.push("REL");
        if(this.flagValue & this.CS_IDX)
            stringValues.push("IDX");
        if(this.flagValue & this.CS_BLK)
            stringValues.push("BLK");
        if(this.flagValue & this.CS_PRT)
            stringValues.push("PRT");
        if(this.flagValue & this.CS_TERMINAL)
            stringValues.push("TERMINAL");
        if(this.flagValue & this.CS_DBL)
            stringValues.push("DBL");
        if(this.flagValue & this.CS_CONSOLE)
            stringValues.push("CONSOLE");
        if(this.flagValue & this.CS_CHRDEV)
            stringValues.push("CHRDEV");
        if(this.flagValue & this.CS_PIPE)
            stringValues.push("PIPE");
        if(this.flagValue & this.CS_PRINTER)
            stringValues.push("PRINTER");
        if(this.flagValue & this.CS_BUFFERED)
            stringValues.push("BUFFERED");

        var result = stringValues.join("|");
        return result == "" ? "None" : result;
    }
}

class HandleTypes
{
    constructor(handle)
    {
        this.flagValue = handle;
        this.DMTYP_HND = 0x00000001;  /* This is normal handle memory	*/
        this.DMTYP_WND = 0x00000002;  /* There is a window associated	*/
        this.DMTYP_RCB = 0x00000004;  /* This is RCB memory			*/
        this.DMTYP_WPR = 0x00000008;  /* This is Windows API Printer memory	*/
        this.DMTYP_WPN = 0x00000010;  /* This is Windows API Pen memory	*/
        this.DMTYP_RNC = 0x00000020;  /* This is RNC memory			*/
        this.DMTYP_NAM = 0x00000040;  /* This is Name space memory		*/
        this.DMTYP_CLS = 0x00000080;  /* This is Class memory		*/
        this.DMTYP_OBJ = 0x00000100;  /* This is Object memory		*/
        this.DMTYP_MSG = 0x00000200;  /* This is Message block memory	*/
        this.DMTYP_FRM = 0x00000400;  /* This is Frame memory		*/
        this.isMemory = (this.flagValue & this.DMTYP_HND) ? true : false;
    }

    stringify()
    {
        var stringValues = [];
        if(this.flagValue & this.DMTYP_HND)
            stringValues.push("Memory Handle");
        if(this.flagValue & this.DMTYP_WND)
            stringValues.push("Window");
        if(this.flagValue & this.DMTYP_RCB)
            stringValues.push("RCB");
        if(this.flagValue & this.DMTYP_WPR)
            stringValues.push("Printer");
        if(this.flagValue & this.DMTYP_WPN)
            stringValues.push("Pen");
        if(this.flagValue & this.DMTYP_RNC)
            stringValues.push("RNC");
        if(this.flagValue & this.DMTYP_NAM)
            stringValues.push("Namespace");
        if(this.flagValue & this.DMTYP_CLS)
            stringValues.push("Class");
        if(this.flagValue & this.DMTYP_OBJ)
            stringValues.push("Object");
        if(this.flagValue & this.DMTYP_MSG)
            stringValues.push("Message Block");
        if(this.flagValue & this.DMTYP_FRM)
            stringValues.push("Frame");

        return stringValues.join("|");
    }
}

function initializeScript() {
    return [
        new host.apiVersionSupport(1, 3),
        new host.functionAlias(
            showHandles,
            'showHandles'
        ),
        new host.functionAlias(
            showChannels,
            'showChannels'
        ),
        new host.functionAlias(
            showTraceback,
            'showTraceback'
        )
    ];
}